import signal
import sys

from rich.console import Console

from .config import build_config
from .display import Display
from .models import ModelQueue
from .session import run_session

console = Console()

# Global state for graceful shutdown
_current_transcript = None
_transcript_dir = None


def _handle_interrupt(signum, frame):
    console.print("\n[yellow]Session interrupted by user.[/yellow]")
    if _current_transcript and _transcript_dir:
        try:
            path = _current_transcript.save(_transcript_dir)
            console.print(f"[yellow]Partial transcript saved to: {path}[/yellow]")
        except Exception:
            pass
    sys.exit(0)


def main():
    global _current_transcript, _transcript_dir

    signal.signal(signal.SIGINT, _handle_interrupt)

    try:
        config = build_config()
    except (FileNotFoundError, RuntimeError) as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    _transcript_dir = config.session.transcript_dir
    queue = ModelQueue(config.models, shuffle=config.session.shuffle)
    display = Display(queue.order_names)

    display.show_header(queue.order_names)

    try:
        first_line = console.input("[bold white]You: [/bold white]")
        if first_line.startswith('"""'):
            # Multi-line mode: collect lines until closing """
            lines = [first_line[3:]]  # strip opening """
            while True:
                line = console.input("")
                if line.rstrip().endswith('"""'):
                    lines.append(line.rstrip()[:-3])  # strip closing """
                    break
                lines.append(line)
            user_prompt = "\n".join(lines).strip()
        else:
            user_prompt = first_line
    except EOFError:
        return

    if not user_prompt.strip():
        console.print("[yellow]Empty prompt. Exiting.[/yellow]")
        return

    console.print()
    display.show_user_prompt(user_prompt)

    transcript = run_session(queue, user_prompt, config.session.max_iterations, display)
    _current_transcript = transcript

    transcript_path = None
    try:
        transcript_path = transcript.save(config.session.transcript_dir)
    except Exception as e:
        console.print(f"[red]Failed to save transcript: {e}[/red]")

    display.show_session_end(len(transcript.iterations), transcript_path)
