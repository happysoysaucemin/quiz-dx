#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把《四科模拟试卷_纠错解析与挖空版》里的「纯客观题_解析版.md」解析成题库 JSON。

用法:
    python tools/build_bank.py [--src <资料根目录>] [--out <bank 目录>]

题库输出（可直接放到任意静态托管 / 仓库）:
    bank/index.json
    bank/13006.json  13007.json  13008.json  13014.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------- 科目元数据
SUBJECTS = {
    "13006": {"name": "软件工程（实践）", "short": "软工", "dir": "02_软件工程实践_13006"},
    "13007": {"name": "编译原理", "short": "编译", "dir": "03_编译原理实践_13007"},
    "13008": {"name": "软件质量保证与测试", "short": "软质保", "dir": "01_软件质量保证与测试_13008"},
    "13014": {"name": "高级语言程序设计（实践）", "short": "高级语言", "dir": "04_高级语言程序设计实践_13014"},
}
ORDER = ["13006", "13007", "13008", "13014"]

SECTION_TYPE = {"填空题": "fill", "单项选择题": "single", "判断题": "judge"}

Q_START = re.compile(r"^\*\*\s*(\d+)\s*[.．、]\s*(.*?)\s*\*\*\s*$")
SECTION = re.compile(r"^##\s*[一二三四五六七八九十]+\s*[、.]\s*(填空题|单项选择题|判断题)")
OPT_SPLIT = re.compile(r"(?:^|[\s　])([A-D])\s*[.．、]\s*")
ANSWER = re.compile(r"^[-*]\s*【答案】\s*(.+?)\s*$")
EXPLAIN = re.compile(r"^[-*]\s*【解析】\s*(.*)$")
FIX = re.compile(r"^[-*]\s*★?【纠错】\s*(.*)$")


def clean(text: str) -> str:
    text = text.replace("＿＿", "______").replace("＿", "_")
    text = text.replace("**", "").replace("\\_", "_")
    text = re.sub(r"[ \t]+", " ", text).strip()
    return text


def split_blanks(answer: str) -> list[list[str]]:
    """把答案拆成每个空的候选答案列表（括号内的顿号不当作分隔符）。"""
    groups: list[str] = []

    def protect(m: re.Match) -> str:
        groups.append(m.group(1))
        return f"\x00{len(groups) - 1}\x00"

    protected = re.sub(r"[（(]([^）)]*)[）)]", protect, answer)
    parts = re.split(r"[、；;]|(?<!\d)，", protected)
    parts = [p.strip() for p in parts if p.strip()]
    if not parts:
        parts = [protected.strip()]

    def restore(text: str) -> str:
        return re.sub(r"\x00(\d+)\x00", lambda m: f"（{groups[int(m.group(1))]}）", text)

    result: list[list[str]] = []
    for part in parts:
        alts = [restore(part)]
        inner = "、".join(groups) if False else None  # 占位，真实内层见下
        for m in re.finditer(r"\x00(\d+)\x00", part):
            inner_text = groups[int(m.group(1))]
            alts.append(inner_text)
            for piece in re.split(r"[、，,；;]|\s*(?:或|/|／)\s*", inner_text):
                piece = piece.strip()
                if piece:
                    alts.append(piece)
        # “A或B” / “A / B”
        extra: list[str] = []
        for alt in list(alts):
            for piece in re.split(r"\s*(?:或|/|／)\s*", alt):
                piece = piece.strip(" ，,。；;")
                if piece:
                    extra.append(piece)
        for piece in extra:
            if piece not in alts:
                alts.append(piece)
        # “中间代码生成（代码优化器）”这类答案，括号前的部分本身也应是可接受答案
        for a in list(alts):
            m = re.search(r"[（(]", a)
            if m and m.start() > 0:
                prefix = a[: m.start()].strip()
                if prefix:
                    alts.append(prefix)
        cleaned: list[str] = []
        for a in alts:
            a = clean(a).strip(" ，,。；;")
            if a and a not in cleaned:
                cleaned.append(a)
        if cleaned:
            result.append(cleaned)
    return result


def parse_options(block_lines: list[str]) -> tuple[list[dict], int]:
    """从题目块里抠出 A-D 选项，返回 (选项列表, 选项起始行号)。"""
    text = "\n".join(block_lines)
    matches = list(OPT_SPLIT.finditer(text))
    matches = [m for m in matches if m.group(1) in "ABCD"]
    if not matches:
        return [], -1
    # 找到从 A 开始、字母递增的一段
    start = next((i for i, m in enumerate(matches) if m.group(1) == "A"), None)
    if start is None:
        return [], -1
    seq = []
    expected = "A"
    for m in matches[start:]:
        if m.group(1) == expected and m.start() >= (matches[start].start()):
            seq.append(m)
            expected = chr(ord(expected) + 1)
        elif seq:
            break
        if expected > "D":
            break
    if len(seq) < 2:
        return [], -1
    opts = []
    for i, m in enumerate(seq):
        body_start = m.end()
        body_end = seq[i + 1].start() if i + 1 < len(seq) else len(text)
        body = text[body_start:body_end].strip()
        body = body.split("\n- 【答案】")[0]
        body = re.split(r"\n[-*]\s*【(答案|解析|纠错)】", body)[0]
        opts.append({"key": m.group(1), "text": clean(body)})
    first_line = text[: seq[0].start()].count("\n")
    return opts, first_line


def parse_file(path: Path, code: str) -> tuple[list[dict], list[str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    qtype = None
    questions: list[dict] = []
    warnings: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        sec = SECTION.match(line)
        if sec:
            qtype = SECTION_TYPE[sec.group(1)]
            i += 1
            continue
        m = Q_START.match(line)
        if not (m and qtype):
            i += 1
            continue
        no = int(m.group(1))
        stem = m.group(2)
        block: list[str] = []
        j = i + 1
        while j < n:
            if Q_START.match(lines[j]) or SECTION.match(lines[j]):
                break
            block.append(lines[j])
            j += 1
        # 题干可能折行：把选项/答案前的普通行并入题干
        opt_opts, opt_line = parse_options(block)
        if opt_line > 0:
            stem = stem + " " + " ".join(block[:opt_line])
        elif opt_line < 0:
            plain = []
            for bl in block:
                if bl.startswith("-") or not bl.strip():
                    break
                plain.append(bl.strip())
            if plain:
                stem = stem + " " + " ".join(plain)
        stem = clean(stem)

        answer = ""
        explain: list[str] = []
        note: list[str] = []
        for bl in block:
            a = ANSWER.match(bl)
            if a:
                answer = clean(a.group(1))
                continue
            e = EXPLAIN.match(bl)
            if e:
                explain.append(clean(e.group(1)))
                continue
            f = FIX.match(bl)
            if f:
                note.append(clean(f.group(1)))
                continue
            if explain and not bl.startswith("-"):
                explain.append(clean(bl))
            elif note and not bl.startswith("-") and not explain:
                note.append(clean(bl))

        qid = f"{code}-{qtype}-{no}"
        q: dict = {"id": qid, "no": no, "type": qtype, "stem": stem}

        if qtype == "fill":
            q["blanks"] = max(1, len(re.findall(r"_{2,}", stem)))
            q["answer"] = answer
            q["accept"] = split_blanks(answer) if answer else []
            if q["blanks"] == 1 and len(q["accept"]) > 1:
                # 单空题的答案里用顿号并列多个同义答案，合成为一个空的候选集
                merged = []
                for group in q["accept"]:
                    merged.extend(group)
                q["accept"] = [merged]
        elif qtype == "single":
            q["options"] = opt_opts
            letter = re.match(r"^([A-Da-d])", answer)
            q["answer"] = letter.group(1).upper() if letter else answer
            if not opt_opts:
                warnings.append(f"{qid}: 未解析到选项")
            elif not letter:
                warnings.append(f"{qid}: 未解析到选项字母 -> {answer!r}")
        else:
            truth = ("对" in answer) or ("正确" in answer) or ("√" in answer) or ("✓" in answer)
            if "错" in answer or "✗" in answer or "×" in answer:
                truth = False
            q["answer"] = truth

        if explain:
            q["explain"] = "\n".join(explain)
        if note:
            q["note"] = "\n".join(note)
        if answer:
            q["answerText"] = answer
        questions.append(q)
        i = j
    return questions, warnings


def dedupe(questions: list[dict], warnings: list[str]) -> list[dict]:
    seen: dict[tuple, str] = {}
    kept: list[dict] = []
    for q in questions:
        sig = re.sub(r"[\s，。、,.；;：:（）()【】\[\]“”\"'?？!！ -]", "", q["stem"])
        if q["type"] == "single":
            # 题干经常是“以下描述中正确的是（ ）”这种通用句，必须连选项一起判重
            sig += "|" + "|".join(f"{o['key']}:{o['text']}" for o in q["options"])
        elif q["type"] == "fill":
            sig += "|" + q.get("answer", "")
        key = (q["type"], sig)
        if key in seen:
            warnings.append(f"重复题 {q['id']} 与 {seen[key]}，已跳过")
            continue
        seen[key] = q["id"]
        kept.append(q)
    # 重新编排题号，保持原始 no 便于溯源
    for idx, q in enumerate(kept, 1):
        q["order"] = idx
    return kept


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=None, help="资料根目录（含 0x_科目 子目录）")
    ap.add_argument("--out", default=None, help="输出 bank 目录")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    src = Path(args.src) if args.src else here.parent.parent / "四科模拟试卷_纠错解析与挖空版"
    out = Path(args.out) if args.out else here.parent / "bank"
    out.mkdir(parents=True, exist_ok=True)

    if not src.is_dir():
        print(f"找不到资料目录: {src}", file=sys.stderr)
        return 1

    index = {"version": 1, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "source": src.name, "subjects": []}
    total = 0
    for code in ORDER:
        meta = SUBJECTS[code]
        folder = src / meta["dir"]
        candidates = sorted(folder.glob("*纯客观题_解析版.md")) if folder.is_dir() else []
        if not candidates:
            print(f"[WARN] {code} 未找到纯客观题解析版 md: {folder}", file=sys.stderr)
            continue
        path = candidates[0]
        questions, warnings = parse_file(path, code)
        questions = dedupe(questions, warnings)
        counts = {"fill": 0, "single": 0, "judge": 0}
        for q in questions:
            counts[q["type"]] = counts.get(q["type"], 0) + 1
        subject = {
            "code": code,
            "name": meta["name"],
            "short": meta["short"],
            "file": f"{code}.json",
            "counts": counts,
            "total": len(questions),
            "questions": questions,
        }
        (out / f"{code}.json").write_text(json.dumps(subject, ensure_ascii=False, indent=1), encoding="utf-8")
        index["subjects"].append({k: subject[k] for k in ("code", "name", "short", "file", "counts", "total")})
        total += len(questions)
        print(f"{code} {meta['name']}: {len(questions)} 题  {counts}")
        for w in warnings:
            print("   ! " + w)

    index["total"] = total
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"合计 {total} 题 -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
