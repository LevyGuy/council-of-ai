from rich.console import Console
from rich.panel import Panel
from rich.text import Text

MODEL_COLORS = [
    "cyan",
    "green",
    "magenta",
    "yellow",
    "blue",
    "red",
    "bright_cyan",
    "bright_green",
]

console = Console()


class Display:
    def __init__(self, model_names: list[str]):
        self.color_map: dict[str, str] = {}
        for i, name in enumerate(model_names):
            self.color_map[name] = MODEL_COLORS[i % len(MODEL_COLORS)]

    def show_header(self, model_names: list[str]) -> None:
        order = ", ".join(model_names)
        console.print()
        console.print(Panel(
            f"[bold]Council of AI — New Session[/bold]\nPanel order: {order}",
            style="bold white",
            expand=False,
        ))
        console.print()

    def show_user_prompt(self, prompt: str) -> None:
        console.print(f"[bold white]You:[/bold white] {prompt}")
        console.print()

    def show_model_response(self, model_name: str, role: str, response: str) -> None:
        color = self.color_map.get(model_name, "white")
        header = Text(f"--- {model_name} ({role}) ---", style=f"bold {color}")
        console.print(header)
        console.print(response)
        console.print()

    def show_model_skipped(self, model_name: str, error: str) -> None:
        console.print(f"[red]--- {model_name} (Skipped: {error}) ---[/red]")
        console.print()

    def show_iteration_info(self, iteration: int, max_iterations: int) -> None:
        console.print(f"[dim]--- Iteration {iteration}/{max_iterations} ---[/dim]")
        console.print()

    def show_session_end(self, iterations: int, transcript_path: str | None) -> None:
        lines = [f"Session complete after {iterations} iteration(s)."]
        if transcript_path:
            lines.append(f"Transcript saved to: {transcript_path}")
        console.print()
        console.print(Panel("\n".join(lines), style="bold green", expand=False))
        console.print()
