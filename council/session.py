from .display import Display
from .models import Model, ModelQueue
from .providers.base import Message
from .transcript import Iteration, Transcript, Turn

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


def _build_initial_system_prompt(model_name: str) -> str:
    return (
        f"Your name is {model_name}. A user has posed a question. "
        f"You are the first to respond — no one else has spoken yet. "
        f"Answer the user's question directly. Do NOT reference or address other models, "
        f"as they have not said anything yet. Give a thorough but concise answer."
    )


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


def _build_conversation_text(user_prompt: str, turns: list[Turn]) -> str:
    parts = [f"User: {user_prompt}"]
    for turn in turns:
        parts.append(f"{turn.model_name}: {turn.content}")
    return "\n\n".join(parts)


def _try_send_stream(model: Model, messages: list[Message], display: Display, role: str) -> str | None:
    try:
        stream = model.send_stream(messages)
        return display.stream_model_response(model.name, role, stream)
    except Exception as e:
        display.show_model_skipped(model.name, str(e))
        return None


def run_session(queue: ModelQueue, user_prompt: str, max_iterations: int, display: Display) -> Transcript:
    transcript = Transcript(user_prompt=user_prompt, panel_order=queue.order_names)
    all_turns: list[Turn] = []

    for iteration_num in range(1, max_iterations + 1):
        iteration = Iteration(number=iteration_num)
        display.show_iteration_info(iteration_num, max_iterations)

        if iteration_num == 1:
            # First model gives initial response
            first = queue.first
            messages = [
                Message(role="system", content=_build_initial_system_prompt(first.name)),
                Message(role="user", content=user_prompt),
            ]
            response = _try_send_stream(first, messages, display, "Initial Response")
            if response is None:
                break

            turn = Turn(model_name=first.name, role="Initial Response", content=response)
            all_turns.append(turn)
            iteration.turns.append(turn)

        # Reviewers review ALL previous responses
        for reviewer in queue.reviewers:
            conversation_text = _build_conversation_text(user_prompt, all_turns)
            models_who_spoke = list(dict.fromkeys(t.model_name for t in all_turns))
            messages = [
                Message(role="system", content=_build_review_system_prompt(reviewer.name, models_who_spoke)),
                Message(role="user", content=conversation_text),
            ]
            response = _try_send_stream(reviewer, messages, display, "Review")
            if response is None:
                continue

            turn = Turn(model_name=reviewer.name, role="Review", content=response)
            all_turns.append(turn)
            iteration.turns.append(turn)

        # First model follow-up / summary check
        first = queue.first
        conversation_text = _build_conversation_text(user_prompt, all_turns)
        messages = [
            Message(role="system", content=_build_followup_system_prompt(first.name)),
            Message(role="user", content=conversation_text),
        ]
        response = _try_send_stream(first, messages, display, "Follow-up")
        if response is None:
            break

        turn = Turn(model_name=first.name, role="Follow-up", content=response)
        all_turns.append(turn)
        iteration.turns.append(turn)

        transcript.iterations.append(iteration)

        # Check if first model signals completion
        if COMPLETE_SIGNAL in response:
            break

    # Edge case: save partial turns if no iterations were fully appended
    if not transcript.iterations and all_turns:
        iteration = Iteration(number=1, turns=[t for t in all_turns])
        transcript.iterations.append(iteration)

    return transcript
