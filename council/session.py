from .display import Display
from .models import Model, ModelQueue
from .providers.base import Message
from .transcript import Iteration, Transcript, Turn

COMPLETE_SIGNAL = "[COMPLETE]"


def build_review_system_prompt(current_model: str, conversation_so_far: str) -> str:
    return (
        f"Your name is {current_model}. "
        f"The above is the user's prompt and the responses from other models so far. "
        f"Please review the previous responses and:\n"
        f"a. Grade their accuracy.\n"
        f"b. Offer adjustments if any.\n"
        f"In your response, refer to each model by its name.\n"
        f"Keep your responses short and concise."
    )


def build_followup_system_prompt(first_model: str) -> str:
    return (
        f"Your name is {first_model}. "
        f"The above is the full conversation so far. The other models have reviewed your response. "
        f"Do you have anything to add, correct, or adjust based on their feedback? "
        f"If the conversation is complete and no changes are needed, respond with exactly: {COMPLETE_SIGNAL} "
        f"Otherwise, provide your additions or corrections. Keep your response short and concise."
    )


def build_conversation_text(user_prompt: str, turns: list[Turn]) -> str:
    parts = [f"User: {user_prompt}"]
    for turn in turns:
        parts.append(f"{turn.model_name}: {turn.content}")
    return "\n\n".join(parts)


def _try_send(model: Model, messages: list[Message], display: Display) -> str | None:
    try:
        return model.send(messages)
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
                Message(role="system", content=f"Your name is {first.name}. Keep your responses thorough but concise."),
                Message(role="user", content=user_prompt),
            ]
            response = _try_send(first, messages, display)
            if response is None:
                break

            turn = Turn(model_name=first.name, role="Initial Response", content=response)
            all_turns.append(turn)
            iteration.turns.append(turn)
            display.show_model_response(first.name, "Initial Response", response)

            # Reviewers
            for reviewer in queue.reviewers:
                conversation_text = build_conversation_text(user_prompt, all_turns)
                messages = [
                    Message(role="system", content=build_review_system_prompt(reviewer.name, conversation_text)),
                    Message(role="user", content=conversation_text),
                ]
                response = _try_send(reviewer, messages, display)
                if response is None:
                    continue

                turn = Turn(model_name=reviewer.name, role="Review", content=response)
                all_turns.append(turn)
                iteration.turns.append(turn)
                display.show_model_response(reviewer.name, "Review", response)

        else:
            # Subsequent iterations: reviewers review the first model's follow-up
            for reviewer in queue.reviewers:
                conversation_text = build_conversation_text(user_prompt, all_turns)
                messages = [
                    Message(role="system", content=build_review_system_prompt(reviewer.name, conversation_text)),
                    Message(role="user", content=conversation_text),
                ]
                response = _try_send(reviewer, messages, display)
                if response is None:
                    continue

                turn = Turn(model_name=reviewer.name, role="Review", content=response)
                all_turns.append(turn)
                iteration.turns.append(turn)
                display.show_model_response(reviewer.name, "Review", response)

        # First model follow-up check
        first = queue.first
        conversation_text = build_conversation_text(user_prompt, all_turns)
        messages = [
            Message(role="system", content=build_followup_system_prompt(first.name)),
            Message(role="user", content=conversation_text),
        ]
        response = _try_send(first, messages, display)
        if response is None:
            break

        turn = Turn(model_name=first.name, role="Follow-up", content=response)
        all_turns.append(turn)
        iteration.turns.append(turn)
        display.show_model_response(first.name, "Follow-up", response)

        transcript.iterations.append(iteration)

        # Check if first model signals completion
        if COMPLETE_SIGNAL in response:
            break

    # If no iterations were appended (edge case), still save what we have
    if not transcript.iterations and all_turns:
        iteration = Iteration(number=1, turns=[t for t in all_turns])
        transcript.iterations.append(iteration)

    return transcript
