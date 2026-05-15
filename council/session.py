import logging
import random
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor, as_completed

from .display import Display
from .models import Model, ModelQueue
from .providers.base import Message
from .transcript import Iteration, Transcript, Turn

logger = logging.getLogger("council.session")

COMPLETE_SIGNAL = "[COUNCIL_DONE]"

ROUND_TABLE_PREAMBLE = (
    "You are participating in a formal round table discussion with other AI models. "
    "Maintain a professional, academic tone throughout — as if you are panelists "
    "at a professional conference or peer reviewers in a journal. "
    "Address other participants by name directly (e.g., 'GPT, your point about X is well-taken' "
    "or 'I would note that Gemini's analysis overlooks...'). "
    "Do NOT use casual greetings like 'Hey', 'Hey everyone', 'Great discussion', or similar. "
    "Do NOT narrate in third person (don't say 'Claude provides...' — say 'Claude, you provide...'). "
    "Get straight to the substance.\n\n"
)


def _build_initial_system_prompt(model_name: str, is_followup: bool = False) -> str:
    if is_followup:
        return (
            f"Your name is {model_name}. The user has asked a follow-up question "
            f"to a previous council discussion. The full prior conversation is provided for context. "
            f"You are the first to respond to this follow-up — no one else has spoken yet on this new question. "
            f"Answer the user's follow-up question directly, building on the prior discussion. "
            f"Do NOT reference or address other models, as they have not said anything yet on this follow-up. "
            f"Give a thorough but concise answer."
        )
    return (
        f"Your name is {model_name}. A user has posed a question. "
        f"You are the first to respond — no one else has spoken yet. "
        f"Answer the user's question directly. Do NOT reference or address other models, "
        f"as they have not said anything yet. Give a thorough but concise answer."
    )


def _build_independent_system_prompt(model_name: str, is_followup: bool = False) -> str:
    base = (
        f"Your name is {model_name}. You are preparing for a multi-model council. "
        "Write your best independent answer before seeing any other model's response. "
        "Do not mention the council process or other models. "
        "Prioritize accuracy, useful nuance, and a clear answer to the user."
    )
    if is_followup:
        return (
            base
            + " The user is asking a follow-up question; use the provided prior conversation only as context."
        )
    return base


def _build_review_system_prompt(current_model: str, models_who_spoke: list[str]) -> str:
    spoke_str = ", ".join(models_who_spoke)
    return (
        ROUND_TABLE_PREAMBLE
        + f"Your name is {current_model}. "
        f"You are sitting at a round table discussion. "
        f"The user asked a question and so far the following participants have responded: {spoke_str}. "
        f"ONLY review and reference models whose responses actually appear above. "
        f"Do NOT reference or address any model that has not spoken yet. "
        f"Review ALL of the responses above — not just the last one. "
        f"For each response you find noteworthy:\n"
        f"a. Grade its accuracy.\n"
        f"b. Offer adjustments or push back if you disagree.\n"
        f"c. Highlight points you agree with.\n"
        f"Address each participant by name directly. "
        f"Keep your response short and concise."
    )


def _build_anonymous_review_system_prompt(current_model: str) -> str:
    return (
        f"Your name is {current_model}. You are privately reviewing anonymized answers "
        "from a multi-model council. Do not guess which model wrote which response. "
        "Evaluate only the content.\n\n"
        "For each response, briefly assess accuracy, insight, omissions, and useful points. "
        "Then provide a final ranking from best to worst.\n\n"
        "Your final ranking MUST use this exact format:\n"
        "FINAL RANKING:\n"
        "1. Response A\n"
        "2. Response B\n"
        "Only use the response labels provided in the prompt."
    )


def _build_discussion_system_prompt(model_name: str) -> str:
    return (
        ROUND_TABLE_PREAMBLE
        + f"Your name is {model_name}. The council has already completed private independent "
        "answers and anonymous peer review. You are now in the visible named council discussion. "
        "Use the preparation brief to discuss the strongest points, disagreements, and minority views. "
        "Be candid but concise. Address other participants by name when responding to their points. "
        "Do not claim that the private review removed all bias; treat it as useful evidence."
    )


def _build_chair_system_prompt(chair_name: str) -> str:
    return (
        ROUND_TABLE_PREAMBLE
        + f"Your name is {chair_name}. You are chairing the council after private independent "
        "answers, anonymous peer review, and a named discussion. Produce the final answer for the user. "
        "Include the practical consensus, important caveats, and a short minority report if a plausible "
        "lower-ranked view should not be ignored. Do not include process markers."
    )


def _build_followup_system_prompt(first_model: str) -> str:
    return (
        ROUND_TABLE_PREAMBLE
        + f"Your name is {first_model}. You gave the initial response and the rest of the table "
        f"has weighed in with their reviews and feedback.\n\n"
        f"If you believe the discussion has reached a solid conclusion, provide a brief summary that includes:\n"
        f"- What the user originally asked\n"
        f"- The key points and consensus from the discussion\n"
        f"- Any remaining nuances or caveats\n"
        f"End your summary with the marker: {COMPLETE_SIGNAL}\n\n"
        f"If you think there are still meaningful points to address or corrections to make, "
        f"share them and do NOT include {COMPLETE_SIGNAL}. "
        f"Keep your response short and concise."
    )


def _build_user_message(user_prompt: str, rag_context: str = "") -> str:
    """Combine optional RAG context with the user's question."""
    if rag_context:
        return f"{rag_context}\n\nUser question: {user_prompt}"
    return user_prompt


def _build_conversation_text(
    user_prompt: str, turns: list[Turn], rag_context: str = "",
    prior_conversation: str = "",
) -> str:
    parts = []
    if prior_conversation:
        parts.append(prior_conversation)
        parts.append(f"User (follow-up): {_build_user_message(user_prompt, rag_context)}")
    else:
        parts.append(f"User: {_build_user_message(user_prompt, rag_context)}")
    for turn in turns:
        parts.append(f"{turn.model_name}: {turn.content}")
    return "\n\n".join(parts)


def _build_anonymous_review_prompt(user_prompt: str, labeled_answers: list[tuple[str, Turn]]) -> str:
    responses_text = "\n\n".join(
        f"{label}:\n{turn.content}" for label, turn in labeled_answers
    )
    return (
        "The user asked:\n"
        f"{user_prompt}\n\n"
        "Here are independent answers from different models. They have been anonymized:\n\n"
        f"{responses_text}\n\n"
        "Evaluate the responses and rank them from best to worst."
    )


def _parse_ranking(text: str) -> list[str]:
    import re

    ranking_text = text.split("FINAL RANKING:", 1)[1] if "FINAL RANKING:" in text else text
    seen: set[str] = set()
    labels: list[str] = []
    for match in re.findall(r"Response [A-Z]", ranking_text):
        if match not in seen:
            seen.add(match)
            labels.append(match)
    return labels


def _aggregate_rankings(review_turns: list[Turn], reviewer_label_maps: dict[str, dict[str, str]]) -> list[dict]:
    positions: dict[str, list[int]] = {}
    first_place: dict[str, int] = {}

    for turn in review_turns:
        label_map = reviewer_label_maps.get(turn.model_name, {})
        for position, label in enumerate(_parse_ranking(turn.content), start=1):
            model_name = label_map.get(label)
            if not model_name:
                continue
            positions.setdefault(model_name, []).append(position)
            if position == 1:
                first_place[model_name] = first_place.get(model_name, 0) + 1

    aggregate = []
    for model_name, model_positions in positions.items():
        aggregate.append({
            "model": model_name,
            "average_rank": round(sum(model_positions) / len(model_positions), 2),
            "rankings_count": len(model_positions),
            "first_place_votes": first_place.get(model_name, 0),
        })
    aggregate.sort(key=lambda item: (item["average_rank"], -item["first_place_votes"], item["model"]))
    return aggregate


def _build_preparation_brief(
    user_prompt: str,
    independent_turns: list[Turn],
    review_turns: list[Turn],
    reviewer_label_maps: dict[str, dict[str, str]],
    aggregate_rankings: list[dict],
) -> str:
    answer_text = "\n\n".join(
        f"{turn.model_name} independent answer:\n{turn.content}" for turn in independent_turns
    )
    review_text = "\n\n".join(
        f"{turn.model_name} anonymous review label map: {reviewer_label_maps.get(turn.model_name, {})}\n"
        f"{turn.content}"
        for turn in review_turns
    )
    ranking_text = "\n".join(
        f"- {item['model']}: avg rank {item['average_rank']} "
        f"({item['first_place_votes']} first-place vote(s), {item['rankings_count']} ranking(s))"
        for item in aggregate_rankings
    ) or "- No parseable rankings."

    return (
        "=== Council Preparation Brief ===\n"
        f"User question: {user_prompt}\n\n"
        "Independent answers were collected privately before models saw each other.\n\n"
        f"{answer_text}\n\n"
        "Anonymous peer reviews and rankings:\n"
        f"{review_text}\n\n"
        "Aggregate ranking signal:\n"
        f"{ranking_text}\n"
        "=== End Preparation Brief ==="
    )


def _send_non_streaming(model: Model, messages: list[Message]) -> tuple[Model, str | None, Exception | None]:
    try:
        return model, model.send(messages), None
    except Exception as e:
        return model, None, e


def _collect_independent_turns(
    queue: ModelQueue,
    user_prompt: str,
    rag_context: str = "",
    prior_conversation: str = "",
) -> tuple[list[Turn], list[tuple[str, str]]]:
    is_followup = bool(prior_conversation)
    independent_turns: list[Turn] = []
    errors: list[tuple[str, str]] = []

    def messages_for(model: Model) -> list[Message]:
        user_content = (
            _build_conversation_text(user_prompt, [], rag_context, prior_conversation)
            if is_followup
            else _build_user_message(user_prompt, rag_context)
        )
        return [
            Message(role="system", content=_build_independent_system_prompt(model.name, is_followup)),
            Message(role="user", content=user_content),
        ]

    with ThreadPoolExecutor(max_workers=len(queue.models)) as executor:
        futures = {
            executor.submit(_send_non_streaming, model, messages_for(model)): model
            for model in queue.models
        }
        for future in as_completed(futures):
            model, response, error = future.result()
            if error or response is None:
                errors.append((model.name, str(error) if error else "empty response"))
                continue
            independent_turns.append(Turn(model_name=model.name, role="Private Independent Answer", content=response))

    order = {name: i for i, name in enumerate(queue.order_names)}
    independent_turns.sort(key=lambda turn: order.get(turn.model_name, 999))
    return independent_turns, errors


def _collect_anonymous_review_turns(
    queue: ModelQueue,
    user_prompt: str,
    independent_turns: list[Turn],
) -> tuple[list[Turn], dict[str, dict[str, str]], list[tuple[str, str]]]:
    review_turns: list[Turn] = []
    reviewer_label_maps: dict[str, dict[str, str]] = {}
    errors: list[tuple[str, str]] = []

    def messages_for(model: Model) -> list[Message]:
        shuffled_turns = list(independent_turns)
        random.shuffle(shuffled_turns)
        labeled_turns = [(f"Response {chr(65 + i)}", turn) for i, turn in enumerate(shuffled_turns)]
        reviewer_label_maps[model.name] = {label: turn.model_name for label, turn in labeled_turns}
        return [
            Message(role="system", content=_build_anonymous_review_system_prompt(model.name)),
            Message(role="user", content=_build_anonymous_review_prompt(user_prompt, labeled_turns)),
        ]

    with ThreadPoolExecutor(max_workers=len(queue.models)) as executor:
        futures = {
            executor.submit(_send_non_streaming, model, messages_for(model)): model
            for model in queue.models
        }
        for future in as_completed(futures):
            model, response, error = future.result()
            if error or response is None:
                errors.append((model.name, str(error) if error else "empty response"))
                continue
            review_turns.append(Turn(model_name=model.name, role="Anonymous Peer Review", content=response))

    order = {name: i for i, name in enumerate(queue.order_names)}
    review_turns.sort(key=lambda turn: order.get(turn.model_name, 999))
    return review_turns, reviewer_label_maps, errors


def _try_send_stream(model: Model, messages: list[Message], display: Display, role: str) -> str | None:
    try:
        stream = model.send_stream(messages)
        return display.stream_model_response(model.name, role, stream)
    except Exception as e:
        display.show_model_skipped(model.name, str(e))
        return None


def run_session(queue: ModelQueue, user_prompt: str, max_iterations: int, display: Display) -> Transcript:
    transcript = Transcript(user_prompt=user_prompt, panel_order=queue.order_names)
    iteration = Iteration(number=1)
    display.show_iteration_info(1, 1)

    display.show_model_response("System", "Preparing Council", "Collecting independent answers...")
    independent_turns, independent_errors = _collect_independent_turns(queue, user_prompt)
    for model_name, error in independent_errors:
        display.show_model_skipped(model_name, error)

    if not independent_turns:
        transcript.iterations.append(iteration)
        return transcript

    display.show_model_response("System", "Preparing Council", "Running anonymous peer review...")
    review_turns, reviewer_label_maps, review_errors = _collect_anonymous_review_turns(
        queue, user_prompt, independent_turns,
    )
    for model_name, error in review_errors:
        display.show_model_skipped(model_name, error)

    aggregate_rankings = _aggregate_rankings(review_turns, reviewer_label_maps)
    preparation_brief = _build_preparation_brief(
        user_prompt, independent_turns, review_turns, reviewer_label_maps, aggregate_rankings,
    )
    iteration.turns.extend(independent_turns)
    iteration.turns.extend(review_turns)

    visible_turns: list[Turn] = []
    for model in queue.models:
        conversation_text = _build_conversation_text(user_prompt, visible_turns, prior_conversation=preparation_brief)
        messages = [
            Message(role="system", content=_build_discussion_system_prompt(model.name)),
            Message(role="user", content=conversation_text),
        ]
        response = _try_send_stream(model, messages, display, "Council Discussion")
        if response is None:
            continue
        turn = Turn(model_name=model.name, role="Council Discussion", content=response)
        visible_turns.append(turn)
        iteration.turns.append(turn)

    chair = queue.first
    conversation_text = _build_conversation_text(user_prompt, visible_turns, prior_conversation=preparation_brief)
    messages = [
        Message(role="system", content=_build_chair_system_prompt(chair.name)),
        Message(role="user", content=conversation_text),
    ]
    response = _try_send_stream(chair, messages, display, "Final Synthesis")
    if response is not None:
        iteration.turns.append(Turn(model_name=chair.name, role="Final Synthesis", content=response))

    transcript.iterations.append(iteration)

    return transcript


# ---------------------------------------------------------------------------
# Web / SSE event-based session (yields dicts instead of writing to Display)
# ---------------------------------------------------------------------------

def _model_key(name: str) -> str:
    """Map model display name to avatar data-model key."""
    return name.lower()


def run_session_events(
    queue: ModelQueue, user_prompt: str, max_iterations: int,
    rag_context: str = "", prior_conversation: str = "",
) -> Generator[dict, None, None]:
    """Run a deliberation session, yielding SSE-friendly event dicts.

    Event types:
        session_start  — panel order info
        iteration      — iteration separator
        speaker        — which model is about to speak
        chunk          — a text chunk from the streaming response
        turn_end       — full text of the completed turn
        error          — a model was skipped
        done           — session complete, includes transcript + conversation_text
    """
    is_followup = bool(prior_conversation)
    logger.info(
        "run_session_events started: prompt=%r, max_iter=%d, followup=%s",
        user_prompt[:80], max_iterations, is_followup,
    )
    if rag_context:
        logger.info("RAG context attached: %d chars", len(rag_context))

    transcript = Transcript(user_prompt=user_prompt, panel_order=queue.order_names)
    visible_turns: list[Turn] = []
    iteration = Iteration(number=1)

    yield {
        "type": "session_start",
        "models": [{"name": m.name, "key": _model_key(m.name)} for m in queue.models],
    }

    yield {
        "type": "preparation_start",
        "title": "Preparing council",
        "steps": [
            "Collecting independent answers",
            "Running anonymous peer review",
            "Mapping disagreements",
        ],
    }

    independent_turns, independent_errors = _collect_independent_turns(
        queue, user_prompt, rag_context, prior_conversation,
    )
    for turn in independent_turns:
        yield {
            "type": "preparation_item",
            "stage": "independent",
            "model_key": _model_key(turn.model_name),
            "name": turn.model_name,
            "label": f"{turn.model_name} wrote an independent answer",
            "content": turn.content,
        }
    for model_name, error in independent_errors:
        yield {"type": "error", "model": model_name, "message": error}

    if not independent_turns:
        transcript.iterations.append(iteration)
        yield {"type": "done", "transcript": transcript, "conversation_text": prior_conversation}
        return

    review_turns, reviewer_label_maps, review_errors = _collect_anonymous_review_turns(
        queue, user_prompt, independent_turns,
    )
    for turn in review_turns:
        yield {
            "type": "preparation_item",
            "stage": "review",
            "model_key": _model_key(turn.model_name),
            "name": turn.model_name,
            "label": f"{turn.model_name} completed anonymous peer review",
            "content": turn.content,
            "label_map": reviewer_label_maps.get(turn.model_name, {}),
            "ranking": _parse_ranking(turn.content),
        }
    for model_name, error in review_errors:
        yield {"type": "error", "model": model_name, "message": error}

    aggregate_rankings = _aggregate_rankings(review_turns, reviewer_label_maps)
    preparation_brief = _build_preparation_brief(
        user_prompt, independent_turns, review_turns, reviewer_label_maps, aggregate_rankings,
    )
    iteration.turns.extend(independent_turns)
    iteration.turns.extend(review_turns)

    yield {
        "type": "preparation_complete",
        "aggregate_rankings": aggregate_rankings,
        "brief": preparation_brief,
    }

    yield {"type": "iteration", "number": 1, "max": 1, "label": "Named council discussion"}

    for model in queue.models:
        conversation_text = _build_conversation_text(
            user_prompt, visible_turns, prior_conversation=preparation_brief,
        )
        messages = [
            Message(role="system", content=_build_discussion_system_prompt(model.name)),
            Message(role="user", content=conversation_text),
        ]
        response = yield from _stream_model_events(model, messages, "Council Discussion")
        if response is None:
            continue
        clean_response = response.replace(COMPLETE_SIGNAL, "").strip()
        turn = Turn(model_name=model.name, role="Council Discussion", content=clean_response)
        visible_turns.append(turn)
        iteration.turns.append(turn)

    chair = queue.first
    conversation_text = _build_conversation_text(
        user_prompt, visible_turns, prior_conversation=preparation_brief,
    )
    messages = [
        Message(role="system", content=_build_chair_system_prompt(chair.name)),
        Message(role="user", content=conversation_text),
    ]
    response = yield from _stream_model_events(chair, messages, "Final Synthesis")
    if response is not None:
        clean_response = response.replace(COMPLETE_SIGNAL, "").strip()
        turn = Turn(model_name=chair.name, role="Final Synthesis", content=clean_response)
        visible_turns.append(turn)
        iteration.turns.append(turn)

    transcript.iterations.append(iteration)
    full_conversation = _build_conversation_text(
        user_prompt, visible_turns, prior_conversation=preparation_brief,
    )
    yield {"type": "done", "transcript": transcript, "conversation_text": full_conversation}


def _stream_model_events(
    model: Model, messages: list[Message], role: str
) -> Generator[dict, None, str | None]:
    """Yield speaker + chunk events, return the full text (or None on failure)."""
    logger.info("Streaming %s (%s)...", model.name, role)
    yield {
        "type": "speaker",
        "model_key": _model_key(model.name),
        "name": model.name,
        "role": role,
    }

    try:
        chunks: list[str] = []
        for chunk in model.send_stream(messages):
            chunks.append(chunk)
            yield {"type": "chunk", "text": chunk}
        full_text = "".join(chunks)
        logger.info("%s (%s) finished: %d chars", model.name, role, len(full_text))
        # Strip COMPLETE_SIGNAL from the turn_end content sent to the client
        clean_text = full_text.replace(COMPLETE_SIGNAL, "").strip()
        yield {"type": "turn_end", "content": clean_text}
        return full_text
    except Exception as e:
        logger.error("%s (%s) failed: %s", model.name, role, e)
        yield {"type": "error", "model": model.name, "message": str(e)}
        return None
