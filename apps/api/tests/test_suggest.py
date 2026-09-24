from rx_jev_api.suggest import suggest

NAMES = [
    "advair",
    "advil",
    "advil pm",
    "glipiZIDE / metFORMIN",
    "metFORMIN",
    "sitagliptin / metFORMIN",
    "tylenol",
    "tylenol pm",
]


def test_prefix_matches_ignore_case() -> None:
    assert suggest(NAMES, "ADV") == ["advil", "advair", "advil pm"]


def test_shorter_names_come_first_among_prefix_matches() -> None:
    assert suggest(NAMES, "tylenol") == ["tylenol", "tylenol pm"]


def test_word_start_matches_follow_prefix_matches() -> None:
    assert suggest(NAMES, "metf") == [
        "metFORMIN",
        "glipiZIDE / metFORMIN",
        "sitagliptin / metFORMIN",
    ]


def test_matches_inside_a_word_are_ignored() -> None:
    assert suggest(NAMES, "formin") == []


def test_surrounding_space_is_ignored() -> None:
    assert suggest(NAMES, "  advil ") == ["advil", "advil pm"]


def test_limit_caps_the_list() -> None:
    assert suggest(NAMES, "a", limit=2) == ["advil", "advair"]
