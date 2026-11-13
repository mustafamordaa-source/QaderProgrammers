"""Task templates, one per kind.

A template gives the description a skeleton (headings to fill in), lists the
headings that must have text before the task is accepted, and suggests
acceptance criteria. Vague tasks are where agents go wrong most, so a bug
without steps to reproduce, or a feature without a scope, is refused.
"""

from __future__ import annotations

import re

from app.models import TaskKind

TEMPLATES: dict[TaskKind, dict] = {
    TaskKind.task: {
        "label": "Task",
        "skeleton": "",
        "required": [],
        "criteria": [],
    },
    TaskKind.bug: {
        "label": "Bug",
        "skeleton": "Steps:\n1. \n\nExpected:\n\nActual:\n\nWhere: (page, endpoint, file)\n",
        "required": ["Steps:", "Expected:", "Actual:"],
        "criteria": [
            "The steps no longer reproduce the bug",
            "A test covers the case",
        ],
    },
    TaskKind.feature: {
        "label": "Feature",
        "skeleton": "Goal:\n\nScope:\n- \n\nOut of scope:\n- \n\nUsers: (who sees it)\n",
        "required": ["Goal:", "Scope:"],
        "criteria": [
            "Works as written in Scope",
            "Tests cover the new behaviour",
            "User-facing text exists in Arabic and English",
        ],
    },
    TaskKind.chore: {
        "label": "Chore",
        "skeleton": "What:\n\nWhy now:\n",
        "required": [],
        "criteria": ["Nothing else changes (tests pass as before)"],
    },
    TaskKind.content: {
        "label": "Content",
        "skeleton": "Source:\n\nWhat to produce:\n\nLanguage: (ar, en, both)\n",
        "required": ["Source:"],
        "criteria": ["A content person reviewed it"],
    },
    TaskKind.docs: {
        "label": "Docs",
        "skeleton": "Which doc:\n\nWhat is missing or wrong:\n",
        "required": [],
        "criteria": ["The doc is linked from this task's context"],
    },
    TaskKind.research: {
        "label": "Research",
        "skeleton": "Question:\n\nWhy it matters:\n\nTime box:\n",
        "required": ["Question:"],
        "criteria": ["Findings written as a task document"],
    },
}


def missing_sections(kind: TaskKind, description: str | None) -> list[str]:
    """Required headings that are absent or have nothing after them."""
    text = description or ""
    missing = []
    for heading in TEMPLATES[kind]["required"]:
        # The heading, then any text on its line or on the following lines
        # before the next "Word:" heading.
        pattern = rf"(?ims)^[ \t]*{re.escape(heading)}(.*?)(?=^[ \t]*[A-Z][\w /()-]*:|\Z)"
        match = re.search(pattern, text)
        # Empty list markers ("1.", "-") left from the skeleton do not count.
        body = re.sub(r"(?m)^[ \t]*(?:\d+[.)]|[-*])?[ \t]*$", "", match.group(1)).strip() if match else ""
        if not body:
            missing.append(heading)
    return missing


def as_json() -> list[dict]:
    return [
        {"kind": kind.value, **{k: v for k, v in spec.items()}}
        for kind, spec in TEMPLATES.items()
    ]
