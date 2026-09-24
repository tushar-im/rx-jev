"""The v1 question catalog and which label sections may answer each question.

Code, not the model, decides the candidate sections. The mapper reads the sections a label
actually has, because product type metadata is not reliable: some repackager labels marked
prescription use the OTC Drug Facts layout, and older prescription labels predate the PLR
layout and use `warnings` and `precautions` instead of `warnings_and_cautions`.
"""

from typing import Literal

from pydantic import BaseModel

from rx_jev_api.clients.openfda import Label

__all__ = [
    "CATALOG",
    "Question",
    "QuestionId",
    "candidate_sections",
    "custom_sections",
    "get_question",
    "label_format",
]

QuestionId = Literal[
    "pregnancy",
    "breastfeeding",
    "children",
    "older_adults",
    "diabetes",
    "high_blood_pressure",
    "kidney",
    "liver",
    "heart",
    "asthma",
    "glaucoma",
    "enlarged_prostate",
    "stomach_ulcers",
    "alcohol",
    "blood_thinners",
    "drowsiness_driving",
    "take_with_food",
    "boxed_warning",
    "allergy",
]
Group = Literal["who", "conditions", "combinations", "daily_life", "serious"]
LabelFormat = Literal["otc", "prescription"]


class Question(BaseModel, frozen=True):
    id: QuestionId
    group: Group
    title: str
    # What Jev is asked about, phrased to fit "what does this label say about <subject>".
    # Question IDs are never sent to the model, so this carries the full meaning.
    subject: str
    # Candidate sections in priority order, per label layout. Old-layout prescription
    # fallbacks sit next to their PLR equivalents; absent sections are skipped.
    otc_sections: tuple[str, ...]
    prescription_sections: tuple[str, ...]
    # Extra rules for this question's stance, added to the shared reading rules.
    stance_rules: tuple[str, ...] = ()


# Sections that only appear in the OTC Drug Facts layout.
_OTC_MARKERS = {"do_not_use", "ask_doctor", "ask_doctor_or_pharmacist", "when_using", "stop_use"}
_OTC_MARKERS |= {"pregnancy_or_breast_feeding"}

_CONDITION_OTC = ("do_not_use", "ask_doctor", "warnings")
_CONDITION_RX = (
    "contraindications",
    "warnings_and_cautions",
    "warnings",
    "precautions",
    "use_in_specific_populations",
)


def _condition(id_: QuestionId, title: str, subject: str) -> Question:
    return Question(
        id=id_,
        group="conditions",
        title=title,
        subject=subject,
        otc_sections=_CONDITION_OTC,
        prescription_sections=_CONDITION_RX,
    )


CATALOG: tuple[Question, ...] = (
    Question(
        id="pregnancy",
        subject="use during pregnancy",
        group="who",
        title="Pregnancy",
        otc_sections=("pregnancy_or_breast_feeding",),
        prescription_sections=("pregnancy", "use_in_specific_populations"),
    ),
    Question(
        id="breastfeeding",
        subject="use while breastfeeding",
        group="who",
        title="Breastfeeding",
        otc_sections=("pregnancy_or_breast_feeding",),
        prescription_sections=("nursing_mothers", "use_in_specific_populations"),
    ),
    Question(
        id="children",
        subject="use in children",
        group="who",
        title="Children",
        otc_sections=("do_not_use", "dosage_and_administration"),
        prescription_sections=("pediatric_use",),
        # Agreed at Gate 1: unestablished safety tells parents something, so it is not silence.
        stance_rules=(
            "A statement that safety or effectiveness in children or pediatric patients has "
            "not been established is `caution`, not `not_mentioned`.",
        ),
    ),
    Question(
        id="older_adults",
        subject="use in older adults",
        group="who",
        title="Older adults",
        otc_sections=("ask_doctor", "dosage_and_administration"),
        prescription_sections=("geriatric_use",),
    ),
    _condition("diabetes", "Diabetes", "people who have diabetes"),
    _condition("high_blood_pressure", "High blood pressure", "people who have high blood pressure"),
    _condition(
        "kidney", "Kidney disease", "people who have kidney disease or reduced kidney function"
    ),
    _condition("liver", "Liver disease", "people who have liver disease"),
    _condition("heart", "Heart disease", "people who have heart disease, including heart failure"),
    _condition("asthma", "Asthma", "people who have asthma"),
    _condition("glaucoma", "Glaucoma", "people who have glaucoma"),
    _condition(
        "enlarged_prostate",
        "Enlarged prostate",
        "people who have an enlarged prostate or trouble urinating",
    ),
    _condition(
        "stomach_ulcers",
        "Stomach ulcers or bleeding",
        "people who have stomach ulcers or stomach bleeding",
    ),
    Question(
        id="alcohol",
        subject="drinking alcohol while using this drug",
        group="combinations",
        title="Alcohol",
        otc_sections=("warnings", "when_using"),
        prescription_sections=(
            "warnings_and_cautions",
            "warnings",
            "precautions",
            "drug_interactions",
        ),
    ),
    Question(
        id="blood_thinners",
        subject="using this drug together with blood thinners (anticoagulants such as warfarin)",
        group="combinations",
        title="Blood thinners",
        otc_sections=("ask_doctor_or_pharmacist",),
        prescription_sections=("drug_interactions",),
    ),
    Question(
        id="drowsiness_driving",
        subject="drowsiness, or driving and operating machinery, while using this drug",
        group="daily_life",
        title="Drowsiness and driving",
        otc_sections=("when_using",),
        prescription_sections=(
            "warnings_and_cautions",
            "warnings",
            "precautions",
            "information_for_patients",
        ),
    ),
    Question(
        id="take_with_food",
        subject="taking this drug with or without food",
        group="daily_life",
        title="Taking with food",
        otc_sections=("dosage_and_administration",),
        prescription_sections=("dosage_and_administration",),
    ),
    Question(
        id="boxed_warning",
        subject="serious risks highlighted in a boxed warning",
        group="serious",
        title="Boxed warning",
        otc_sections=(),
        prescription_sections=("boxed_warning",),
    ),
    Question(
        id="allergy",
        subject="people who have had an allergic reaction to this drug or its ingredients",
        group="serious",
        title="Allergy warnings",
        otc_sections=("do_not_use", "warnings"),
        prescription_sections=("contraindications",),
    ),
)

_BY_ID: dict[str, Question] = {q.id: q for q in CATALOG}


def get_question(question_id: str) -> Question:
    return _BY_ID[question_id]


def label_format(label: Label) -> LabelFormat:
    has_otc_marker = any(label.sections.get(marker, "").strip() for marker in _OTC_MARKERS)
    return "otc" if has_otc_marker else "prescription"


def candidate_sections(question_id: QuestionId, label: Label) -> list[str]:
    question = get_question(question_id)
    wanted = (
        question.otc_sections if label_format(label) == "otc" else question.prescription_sections
    )
    return [name for name in wanted if label.sections.get(name, "").strip()]


def custom_sections(label: Label) -> list[str]:
    """Sections a reader's own question may be answered from: every section the catalog
    reads for this label, in catalog order."""
    return list(dict.fromkeys(s for q in CATALOG for s in candidate_sections(q.id, label)))
