from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


@dataclass
class Turn:
    model_name: str
    role: str  # "Initial Response", "Review", "Follow-up"
    content: str


@dataclass
class Iteration:
    number: int
    turns: list[Turn] = field(default_factory=list)


@dataclass
class Transcript:
    user_prompt: str
    panel_order: list[str]
    iterations: list[Iteration] = field(default_factory=list)
    started_at: datetime = field(default_factory=datetime.now)

    def save(self, transcript_dir: str) -> str:
        path = Path(transcript_dir)
        path.mkdir(parents=True, exist_ok=True)

        filename = self.started_at.strftime("%Y-%m-%d_%H-%M-%S") + ".md"
        filepath = path / filename

        lines = [
            "# Council of AI — Session Transcript",
            f"- **Date**: {self.started_at.strftime('%Y-%m-%d %H:%M:%S')}",
            f"- **Panel order**: {', '.join(self.panel_order)}",
            f"- **Iterations**: {len(self.iterations)}",
            f"- **User prompt**: {self.user_prompt}",
            "",
        ]

        for iteration in self.iterations:
            lines.append(f"## Iteration {iteration.number}")
            lines.append("")
            for turn in iteration.turns:
                lines.append(f"### {turn.model_name} ({turn.role})")
                lines.append("")
                lines.append(turn.content)
                lines.append("")

        filepath.write_text("\n".join(lines))
        return str(filepath)
