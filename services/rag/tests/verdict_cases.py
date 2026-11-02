"""判决口径的表驱动样本：`(answer, evidence, cells)` 的单一来源。

职责边界：
- 本文件只描述**输入样本**，不描述期望值。期望值归 `test_verify.py`（逐条断言口径），
  实际值归 `test_verdict_golden.py` + `golden/verdicts.json`（快照现状）。
- 因此这里**不 import `test_verify.py`**：`test_verify.py` 是断言口径的守卫，
  golden 是实际行为的守卫，两者刻意不共享代码，避免一处改动同时移动两边。

`case_id` 一旦发布就**不得改名**——改名等于删一条 golden 加一条新 golden，
会让"非目标漂移 = 0"这条验收失去意义。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from banking_rag.contract import Evidence


@dataclass(frozen=True)
class VerdictCase:
    """一条判决样本。

    `entailer_verdict` 为 None 表示不注入 entailer（`entailer=None`，即未配置）。
    非 None 时注入一个返回该值的替身，用于锁住"数字 claim 不咨询蕴含层"这条不变量。
    """

    case_id: str
    answer: str
    evidence: tuple[Evidence, ...]
    cells: dict[str, list[str]] = field(default_factory=dict)
    require_citations: bool = True
    entailer_verdict: bool | None = None
    note: str = ""


EVIDENCE = (
    Evidence(
        marker="K1",
        chunk_id=1,
        doc_id="FEE-2025-v3",
        title="稳盈系列费率表（2025版）",
        clause_no="费率表",
        tier=1,
        char_start=0,
        char_end=30,
        text="持有不满7天赎回费率1.50%。",
    ),
)
CELLS = {"K1": ["1.50%"]}

T_PLUS_EVIDENCE = (
    Evidence(
        marker="K2",
        chunk_id=2,
        doc_id="FAQ-REDEEM",
        title="赎回流程 FAQ",
        clause_no=None,
        tier=5,
        char_start=0,
        char_end=40,
        text="赎回到账时间为T+1。",
    ),
)

UNIT_EVIDENCE = (
    Evidence(
        marker="K1",
        chunk_id=3,
        doc_id="FEE-PROMO",
        title="活动费率",
        clause_no="活动规则",
        tier=1,
        char_start=0,
        char_end=30,
        text="活动费率为0.8%。",
    ),
)

CROSS_EVIDENCE = (
    Evidence(
        marker="K1",
        chunk_id=1,
        doc_id="A",
        title="A",
        clause_no=None,
        tier=1,
        char_start=0,
        char_end=20,
        text="A 产品费率为0.8%。",
    ),
    Evidence(
        marker="K2",
        chunk_id=2,
        doc_id="B",
        title="B",
        clause_no=None,
        tier=1,
        char_start=0,
        char_end=20,
        text="B 产品费率为1.50%。",
    ),
)
CROSS_CELLS = {"K1": ["0.8%"], "K2": ["1.50%"]}

V_PROMO_EVIDENCE = (
    Evidence(
        marker="K1",
        chunk_id=4,
        doc_id="PROMO-TERMS",
        title="活动条款",
        clause_no="第二条",
        tier=2,
        char_start=0,
        char_end=32,
        text="活动期间申购费率为0.8%。",
    ),
)
V_PROMO_CELLS = {"K1": ["0.8%"]}


CASES: tuple[VerdictCase, ...] = (
    # ---- 以下 10 条来自 test_verify.py 的 10 组 (answer, evidence, cells) ----
    VerdictCase(
        case_id="V01-green-number-and-literal",
        answer="赎回费率为1.50%[K1]。",
        evidence=EVIDENCE,
        cells=CELLS,
        note="字面与数值都对，判 GREEN 的基准线",
    ),
    VerdictCase(
        case_id="V02-numeric-mismatch",
        answer="赎回费率为15%[K1]。",
        evidence=EVIDENCE,
        cells=CELLS,
        note="数字被改写（1.50%→15%），必须 RED + NUMERIC_MISMATCH",
    ),
    VerdictCase(
        case_id="V03-missing-citation",
        answer="赎回费率为1.50%。",
        evidence=EVIDENCE,
        cells=CELLS,
        note="整句无引用，require_citations=True 下 RED + MISSING_CITATION",
    ),
    VerdictCase(
        case_id="V04-unresolved-marker",
        answer="赎回费率为1.50%[K9]。",
        evidence=EVIDENCE,
        cells=CELLS,
        note="引用了不存在的 marker，RED + SPAN_UNRESOLVED",
    ),
    VerdictCase(
        case_id="V05-literal-failure-no-number",
        answer="赎回费率大概在一点五左右[K1]。",
        evidence=EVIDENCE,
        cells=CELLS,
        note="无数值的字面失败，走蕴含层（未配置则 skipped），AMBER",
    ),
    VerdictCase(
        case_id="V06-tplus-mismatch",
        answer="赎回到账时间为T+9[K2]。",
        evidence=T_PLUS_EVIDENCE,
        cells={"K2": []},
        note="T+N 在到账时效语义下按「天」对账",
    ),
    VerdictCase(
        case_id="V07-unit-mismatch",
        answer="活动费率为0.8 元[K1]。",
        evidence=UNIT_EVIDENCE,
        cells={"K1": ["0.8%"]},
        note="数值相同但单位不符（元 vs %），仍算数字不符",
    ),
    VerdictCase(
        case_id="V08-number-cannot-borrow-other-evidence",
        answer="B 产品费率为0.8%[K2]。",
        evidence=CROSS_EVIDENCE,
        cells=CROSS_CELLS,
        note="数值只能与本 claim 所引证据对账，不得跨证据借用",
    ),
    VerdictCase(
        case_id="V09-require-citations-false-no-marker",
        answer="赎回费率为1.50%。",
        evidence=EVIDENCE,
        cells=CELLS,
        require_citations=False,
        note="无引用即使在宽松模式下也不许判 GREEN；无证据可对账时不得判成数字不符",
    ),
    VerdictCase(
        case_id="V10-numeric-skips-literal-similarity",
        answer="持有不满7天赎回费率为1.51%[K1]。",
        evidence=EVIDENCE,
        cells=CELLS,
        note="只差 0.01，相似度很高也不许 SequenceMatcher 放行",
    ),
    # ---- 以下 3 条是本次新增的边界样本（golden 建立时并不存在于 test_verify.py）----
    VerdictCase(
        case_id="X01-numeric-text-hallucinated",
        answer="活动期间申购费率一律五折，实际为0.8%[K1]。",
        evidence=V_PROMO_EVIDENCE,
        cells=V_PROMO_CELLS,
        entailer_verdict=True,
        note="数字对、文本胡说：注入一个「什么都判支持」的 entailer，不得因此变绿",
    ),
    VerdictCase(
        case_id="X02-numeric-mismatch-entailer-cannot-rescue",
        answer="活动期间申购费率为1.2%[K1]。",
        evidence=V_PROMO_EVIDENCE,
        cells=V_PROMO_CELLS,
        entailer_verdict=True,
        note="数字不符时，蕴含层判 True 也不得救回，理由码必须仍是 NUMERIC_MISMATCH",
    ),
    VerdictCase(
        case_id="X03-non-numeric-entailer-passes",
        answer="转让份额需要提前预约[K1]。",
        evidence=V_PROMO_EVIDENCE,
        cells=V_PROMO_CELLS,
        entailer_verdict=True,
        note="非数字 claim 的蕴含层放行路径（对照项）：字面失败但蕴含判真，只能到 AMBER，不能到 GREEN",
    ),
)


def cases_by_id() -> dict[str, VerdictCase]:
    return {case.case_id: case for case in CASES}


def assert_unique_ids() -> None:
    seen: set[str] = set()
    for case in CASES:
        if case.case_id in seen:
            raise AssertionError(f"case_id 重复：{case.case_id}")
        seen.add(case.case_id)
