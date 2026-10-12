#!/usr/bin/env python3
"""Build RU bot-timeline review cards from the Supabase snapshot.

Two faithful paths, never fabricating a URL or an event:

  A. Published (event-driven): a position with >=1 lifecycle event that was
     actually sent to the RU paid community (carries a message_id_ru). One
     timeline step per *published* event, each with its RU private-Telegram
     signal link. This reproduces the approved hand-authored bot cards.

  B. Evidence-based (no published events): a position with genuine historical
     evidence in Supabase (position.comment_ru, partial_closes, close_comment_ru
     or an event payload comment) but no Telegram message id. We synthesize an
     honest bot-style timeline WITHOUT step links -- exactly what the EN build
     does for NBIS / OUST. Nothing is linked because nothing was linked.

Verbatim rule (standing): text stored in the private group -- comment_ru,
payload.comment_ru, partial_closes.comment_ru, close_comment_ru -- is rendered
byte-for-byte (HTML-escaped only). De-anglicization is applied ONLY to the
sentences/labels this builder generates itself (price fallbacks), never to
stored subscriber text.
"""
import re
from datetime import datetime

RU_CHANNEL = "3773738299"
RU_TOPIC = "4"
PROMO = ('<div class="promo"><span class="promo-h">Следите за сделками BelFed в '
         'реальном времени</span><p class="promo-body">Оформите 14-дневный '
         'бесплатный доступ, чтобы получать профессиональную аналитику и '
         'моментальные оповещения о торговых идеях и наших сделках.</p>'
         '<a class="promo-btn" href="https://belfed.ru/ru/trial.html?source='
         'trial_tradehistory_modal_ru" data-cta="trial">Оформить бесплатный '
         '14-дневный доступ ↗</a></div>')
BOT_INTRO = ("История сделки по сохранённым записям. Ссылки на сообщения подписной "
             "группы указаны, где они доступны; остальные этапы подтверждены торговым журналом.")
LOCK_SVG = ('<svg viewBox="0 0 10 12" width="8" height="9" fill="none" '
            'stroke="currentColor" stroke-width="1.2" style="vertical-align:-1px">'
            '<rect x="1.5" y="5" width="7" height="6" rx="1"/>'
            '<path d="M3 5V3.2A2 2 0 0 1 7 3.2V5"/></svg>')
SIGNAL_LABEL = "сообщение сигнала (для подписчиков)"

TARGET_LABEL = {"target_1_hit": "Цель 1 достигнута",
                "target_2_hit": "Цель 2 достигнута",
                "target_3_hit": "Цель 3 достигнута"}


def deanglicize(text):
    """De-anglicize a *generated* Russian fallback sentence/label.

    Must never be called on stored subscriber text (comment_ru, payloads,
    partial/close comments) -- those are verbatim. It only tidies the sentences
    this module fabricates, dropping the English loanword 'свинг' (swing) and
    the en-dash U+2013 that the RU copy never uses.
    """
    if not text:
        return text
    text = text.replace("свинг-движения", "средне-срочного движения")
    text = text.replace("свинг-движение", "средне-срочное движение")
    text = text.replace("свинг-движении", "средне-срочном движении")
    text = re.sub(r"свинг[- ]?трейд\w*", "средне-срочная сделка", text)
    text = re.sub(r"свинг[- ]?позици", "средне-срочная позици", text)
    text = re.sub(r"\bсвинг\w*", "средне-срочная позиция", text)
    text = text.replace("–", "-")  # en-dash is never used in RU copy
    return text


def esc(s):
    return (str("" if s is None else s)
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def stored(text):
    """Verbatim subscriber text: escape only, never de-anglicize."""
    return esc(text) if text else ""


def gen(text):
    """Generated fallback sentence/label: de-anglicize, then escape."""
    return esc(deanglicize(text)) if text else ""


def num(v):
    if v is None:
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = ("%.8f" % f).rstrip("0").rstrip(".")
    return s if s else "0"


def iso(t):
    return str(t)[:10] if t else ""


def dd(t):
    s = iso(t)
    return s[8:10] + "." + s[5:7] + "." + s[0:4] if s else ""


def badge(direction):
    d = (direction or "").lower()
    if d == "short":
        return '<span class="badge badge-short">Короткая</span>'
    return '<span class="badge badge-long">Длинная</span>'


def r_span(rr):
    if rr is None:
        return '<span class="no-link">—</span>'
    cls = "win" if float(rr) >= 0 else "loss"
    txt = ("+" if float(rr) >= 0 else "") + ("%.2f" % float(rr)) + "R"
    return '<span class="%s">%s</span>' % (cls, txt)


EXIT_EVENTS = {"partial_closed", "closed", "stop_hit", "target_1_hit",
               "target_2_hit", "target_3_hit", "partial_stop_1_hit", "partial_stop_2_hit"}


def _timestamp(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0


def _event_price(ev):
    return ev.get("triggered_price") if ev.get("triggered_price") is not None else (ev.get("payload") or {}).get("triggered_price")


def _system_comment(text):
    return bool(re.search(r"^(auto |corrected |backfilled )|\(per sheet recap\)", str(text or ""), re.I))


def _partial_body(pc):
    summary = "Закрыто %s%% по %s." % (num(pc.get("pct_closed")), num(pc.get("exit_price")))
    comment = pc.get("comment_ru") or ""
    return gen(summary) + (("\n\n" + stored(comment)) if comment and not _system_comment(comment) and comment != summary else "")


def _match_partials(events, partials, pos):
    """One-to-one matching: explicit IDs first, otherwise unique price/time.

    No queue matching and no day-only matching. Publication can lag the ledger
    by seconds; unrelated exits remain separate, unlinked evidence.
    """
    matches, used = {}, set()
    for i, ev in enumerate(events):
        if ev.get("event_type") not in EXIT_EVENTS:
            continue
        pid = (ev.get("payload") or {}).get("partial_close_id")
        for j, pc in enumerate(partials):
            if pid is not None and str(pc.get("id")) == str(pid) and j not in used:
                matches[i] = pc
                used.add(j)
                break
    for i, ev in enumerate(events):
        if ev.get("event_type") not in EXIT_EVENTS or i in matches:
            continue
        terminal = ev.get("event_type") in ("closed", "stop_hit")
        price, at = _event_price(ev), _timestamp(ev.get("triggered_at"))
        if price is None and terminal:
            price = pos.get("exit_price")
        if price is None or not at:
            continue
        candidates = []
        for j, pc in enumerate(partials):
            if j in used or pc.get("exit_price") is None or not _timestamp(pc.get("closed_at")):
                continue
            typ = re.search(r"\b(target_[123]_hit|partial_stop_[12]_hit|stop_hit)\b", pc.get("comment_ru") or "", re.I)
            if typ and typ[1].lower() != ev.get("event_type"):
                continue
            same_price = abs(float(pc["exit_price"]) - float(price)) <= max(1e-8, abs(float(price)) * 1e-9)
            final_fill = (terminal and pos.get("exit_price") is not None
                          and _timestamp(pos.get("closed_at"))
                          and abs(_timestamp(pos["closed_at"]) - at) <= 60
                          and abs(float(pc["exit_price"]) - float(pos["exit_price"])) <= 1e-8)
            if abs(_timestamp(pc.get("closed_at")) - at) <= 60 and (same_price or final_fill):
                candidates.append(j)
        if len(candidates) == 1:
            j = candidates[0]
            matches[i] = partials[j]
            used.add(j)
    return matches, used


def step_body(pos, ev, pc_by_id):
    """Body HTML for a published event step (already escaped).

    Stored subscriber text is verbatim; only fabricated price sentences are
    de-anglicized.
    """
    et = ev.get("event_type")
    pl = ev.get("payload") or {}
    price = num(_event_price(ev) if _event_price(ev) is not None else
                (pos.get("exit_price") if et in ("closed", "stop_hit") else None))
    if et == "opened":
        if pl.get("is_addon"):
            if pl.get("comment_ru"):
                return stored(pl["comment_ru"])
            if pos.get("comment_ru"):
                return stored(pos["comment_ru"])
            return gen("Добавление по %s." % price) if price else ""
        if pos.get("comment_ru"):
            return stored(pos["comment_ru"])
        return gen("Открытие по %s." % price) if price else ""
    if et in ("stop_moved", "edited"):
        if pl.get("comment_ru"):
            return stored(pl["comment_ru"])
        if et == "stop_moved" and pl.get("new_stop") is not None:
            return gen("Стоп перенесён с %s на %s."
                       % (num(pl.get("old_stop")), num(pl.get("new_stop"))))
        return ""
    if et in ("partial_closed", "partial_stop_1_hit", "partial_stop_2_hit"):
        pc = pc_by_id.get(pl.get("partial_close_id")) or pc_by_id.get(str(pl.get("partial_close_id")))
        if pc:
            return _partial_body(pc)
        return gen("Закрыто по %s." % price) if price else ""
    if et in TARGET_LABEL:
        return gen("%s по %s." % (TARGET_LABEL[et], price))
    if et == "stop_hit":
        return gen("Стоп сработал по %s." % price)
    if et == "closed":
        if pos.get("close_comment_ru"):
            return stored(pos["close_comment_ru"])
        if pl.get("comment_ru"):
            return stored(pl["comment_ru"])
        return gen("Закрыто по %s." % price)
    return ""


def step_label(ev):
    et = ev.get("event_type")
    pl = ev.get("payload") or {}
    if et == "opened":
        return "Добавление" if pl.get("is_addon") else "Открытие"
    return {
        "stop_moved": "Стоп перенесён",
        "stop_hit": "Стоп сработал",
        "closed": "Закрытие",
        "partial_closed": "Частичное закрытие",
        "partial_stop_1_hit": "Частичное закрытие",
        "partial_stop_2_hit": "Частичное закрытие",
        "edited": "Обновление",
    }.get(et, TARGET_LABEL.get(et, et))


CHART_ALT = "График на момент операции"


def _https(u):
    v = (u or "").strip() if isinstance(u, str) else ""
    return v if re.match(r"^https://\S+$", v, re.I) else ""


def _chart_img(url):
    m = re.search(r"tradingview\.com/x/([A-Za-z0-9]+)", url or "")
    if not m:
        return ""
    c = m.group(1)
    return "https://s3.tradingview.com/snapshots/%s/%s.png" % (c[0].lower(), c)


def _chart_html(url):
    """Snapshot of the asset at the moment of this operation (or '')."""
    url = _https(url)
    if not url:
        return ""
    img = _chart_img(url)
    if not img:
        return ('<a class="steplink" href="%s" target="_blank" rel="noopener">%s</a>'
                % (esc(url), esc(CHART_ALT)))
    return ('<a class="step-chart" href="%s" target="_blank" rel="noopener">'
            '<img src="%s" alt="%s" loading="lazy" '
            'onerror="var a=this.closest(&quot;.step-chart&quot;);if(a)a.style.display=&quot;none&quot;;"></a>'
            % (esc(url), esc(img), esc(CHART_ALT)))


def step_chart(ev, pc_by_id):
    """Chart URL for a published event step. The initial entry step has none
    (the opening chart already heads the card)."""
    et = ev.get("event_type")
    pl = ev.get("payload") or {}
    if et == "opened" and not pl.get("is_addon"):
        return ""
    url = _https(ev.get("chart_url"))
    if not url and et == "partial_closed":
        pc = pc_by_id.get(pl.get("partial_close_id")) or {}
        url = _https(pc.get("chart_url"))
    return url


def _step_html(label, ts, body, link="", chart=""):
    return ('<li class="step"><div class="step-h"><span class="step-lbl">%s</span>'
            '<span class="step-ts">%s</span></div><div class="step-body">%s</div>%s%s</li>'
            % (esc(label), esc(ts), body, _chart_html(chart), link))


def _signal_link(message_id_ru):
    href = "https://t.me/c/%s/%s/%s" % (RU_CHANNEL, RU_TOPIC, message_id_ru)
    return ('<a class="steplink" href="%s" target="_blank" rel="noopener">%s %s</a>'
            % (href, LOCK_SVG, SIGNAL_LABEL))


def _wrap(pos, steps):
    """Assemble the card shell around a list of <li> step strings."""
    if not steps:
        return None
    rr = pos.get("published_result_rr", pos.get("result_rr"))
    meta_bits = [dd(pos.get("opened_at")) + " → " + (dd(pos.get("closed_at")) or "—")]
    if rr is not None:
        meta_bits.append("Результат: " + ("+" if float(rr) >= 0 else "")
                         + ("%.2f" % float(rr)) + "R")
    else:
        meta_bits.append("Результат: —")
    if pos.get("exit_price") is not None:
        meta_bits.append('<span class="brc-exit">Выход: %s</span>'
                         % esc(num(pos.get("exit_price"))))
    meta = " · ".join(meta_bits)
    head = ('<div class="card-head">%s<span class="card-r">%s</span></div>'
            % (badge(pos.get("direction")), r_span(rr)))
    return ('<article class="card card-t1">%s<div class="card-meta">%s</div>'
            '<p class="bot-intro">%s</p><ol class="timeline">%s</ol>%s</article>'
            % (head, meta, BOT_INTRO, "".join(steps), PROMO))


def _card_from_events(pos, events, pc_by_id):
    """Merge published events with verified ledger exits, without duplication."""
    steps = []
    partials = pos.get("partial_closes") or []
    matches, used = _match_partials(events, partials, pos)
    for i, ev in enumerate(events):
        pc = matches.get(i)
        local_ev = dict(ev, payload=dict(ev.get("payload") or {}))
        if pc:
            local_ev["payload"]["partial_close_id"] = pc["id"]
        body = step_body(pos, local_ev, pc_by_id)
        if pc and ev.get("event_type") not in ("partial_closed", "partial_stop_1_hit", "partial_stop_2_hit"):
            body += "\n\n" + _partial_body(pc)
        ts = dd(ev.get("triggered_at")) or dd(pos.get("opened_at"))
        chart = step_chart(local_ev, pc_by_id) or (_https(pc.get("chart_url")) if pc else "")
        steps.append((_timestamp(ev.get("triggered_at")), _step_html(step_label(ev), ts, body,
                                _signal_link(ev["message_id_ru"]),
                                chart)))
    for i, pc in enumerate(partials):
        if i not in used:
            steps.append((_timestamp(pc.get("closed_at")), _step_html(
                "Частичное закрытие", dd(pc.get("closed_at")), _partial_body(pc),
                chart=pc.get("chart_url") or "")))
    return _wrap(pos, [s for _, s in sorted(steps, key=lambda item: item[0])])


def _card_from_evidence(pos, pc_by_id):
    """Path B: no published events -- synthesize an honest, UNLINKED timeline.

    Steps are built only from evidence that actually exists in the snapshot:
      * an opened step from position.comment_ru (verbatim),
      * one step per partial close, ordered by closed_at (verbatim comment, or
        a generated "Закрыто N% по X." when the partial has no comment),
      * a closing step from close_comment_ru (or an unlinked 'closed' event's
        payload comment) -- only when it is not already the final partial.
    No step carries a Telegram link because none was ever published.
    """
    steps = []
    opened_ts = dd(pos.get("opened_at"))
    if pos.get("comment_ru"):
        steps.append(_step_html("Открытие", opened_ts, stored(pos["comment_ru"])))

    partials = sorted((pos.get("partial_closes") or []),
                      key=lambda pc: (iso(pc.get("closed_at")), pc.get("id") or 0))
    last_partial_iso = iso(partials[-1].get("closed_at")) if partials else ""
    for pc in partials:
        body = _partial_body(pc)
        steps.append(_step_html("Частичное закрытие", dd(pc.get("closed_at")), body,
                                chart=pc.get("chart_url") or ""))

    close_body = ""
    if pos.get("close_comment_ru"):
        close_body = stored(pos["close_comment_ru"])
    else:
        for ev in (pos.get("events") or []):
            if ev.get("event_type") == "closed" and (ev.get("payload") or {}).get("comment_ru"):
                close_body = stored(ev["payload"]["comment_ru"])
                break
    close_iso = iso(pos.get("closed_at"))
    # Suppress a duplicate close step when the last partial already closed the
    # position on the same day (that partial IS the close).
    if close_body and close_iso and close_iso != last_partial_iso:
        steps.append(_step_html("Закрытие", dd(pos.get("closed_at")), close_body))

    return _wrap(pos, steps)


def build_card(pos, pc_by_id):
    """Return the RU bot-card HTML for one position, or None if no steps."""
    linked = [e for e in (pos.get("events") or []) if e.get("message_id_ru")]
    if linked:
        return _card_from_events(pos, linked, pc_by_id)
    return _card_from_evidence(pos, pc_by_id)


def is_eligible(pos):
    """A position deserves a bot card iff genuine published/historical evidence
    exists. A lone position.comment_ru with no events/partials/close is NOT
    enough (that is a bare idea note, not a lifecycle) and stays a legacy card.
    """
    evs = pos.get("events") or []
    if any(e.get("message_id_ru") for e in evs):
        return True
    if pos.get("partial_closes"):
        return True
    if pos.get("close_comment_ru"):
        return True
    if any((e.get("payload") or {}).get("comment_ru") for e in evs):
        return True
    return False


def sheet_row_id_of(pos):
    return pos.get("sheet_row_id") or ""


def _sheet_cell(r, i):
    return r[i].strip() if r and i < len(r) and r[i] is not None else ""


def _sheet_row_index(eq, cr):
    """Map Supabase `sheet_row_id` ("Equties:N" / "Crypto:N") to its sheet row.

    N is the 1-based spreadsheet row number, i.e. array index N-1.
    """
    idx = {}
    for name, data in (("Equties", eq), ("Crypto", cr)):
        for i in range(3, len(data)):
            r = data[i]
            t = _sheet_cell(r, 1)
            if not t or t.lower() == "ticker":
                continue
            idx["%s:%d" % (name, i + 1)] = r
    return idx


def _row_fully_closed(r):
    """True only for a sheet row that is fully closed with an exit and a
    numeric result. Open / Merged / Partially closed rows are excluded.

    A newly generated card for a non-closed position would carry a provisional
    (empty) exit and no result, so -- matching the EN build -- we do not
    prebuild it; the next `--build` after the trade closes picks it up.
    """
    if not r:
        return False
    if _sheet_cell(r, 3).lower() != "closed":
        return False
    if not _sheet_cell(r, 5):          # date of exit
        return False
    result = _sheet_cell(r, 9).replace(",", ".")   # Result / Risk-Reward
    return bool(re.search(r"\d", result))


def build(eq, cr, sb, man):
    """Add/upgrade bot cards for every fully-closed position with genuine
    evidence.

    Cards are generated only for sheet rows whose Status is "Closed" with an
    exit date and a numeric result (open/merged positions are skipped, matching
    the EN build). Existing generated bot cards refresh; manual cards are retained. Ambiguous
    pair-key aliases (shared ticker+entry) are dropped. Returns number written.
    """
    pc_by_id = {pc["id"]: pc for p in sb["positions"] for pc in (p.get("partial_closes") or [])}
    sheet_idx = _sheet_row_index(eq, cr)

    def key_full(t, e, x):
        return "%s|%s|%s" % (t.upper(), e, x)

    def key_safe(pos):
        ac = "cr" if pos.get("asset_class") == "crypto" else "eq"
        dr = (pos.get("direction") or "").lower()[:1] or "?"
        return "%s#%s#%s|%s|%s" % (ac, dr, pos["ticker"].upper(),
                                   iso(pos["opened_at"]), iso(pos["closed_at"]))

    written = 0
    for pos in sb["positions"]:
        if not is_eligible(pos):
            continue
        # Parity with EN: only prebuild for fully-closed sheet rows. Open/merged
        # positions are picked up on a later rebuild once they close.
        if not _row_fully_closed(sheet_idx.get(sheet_row_id_of(pos))):
            continue
        row = sheet_idx[sheet_row_id_of(pos)]
        # Presentation only: match the public row, never mutate DB accounting.
        published = float(str(row[9]).strip().replace(",", "."))
        if pos.get("result_rr") is None or round(float(pos["result_rr"]), 2) != round(published, 2):
            print("  ACCOUNTING_REVIEW %s %s: published=%s, database=%s; no accounting values changed"
                  % (pos["ticker"], iso(pos["opened_at"]), published, pos.get("result_rr")))
        html = build_card(dict(pos, published_result_rr=published), pc_by_id)
        if not html:
            continue
        t, e, x = pos["ticker"], iso(pos["opened_at"]), iso(pos["closed_at"])
        kf = key_full(t, e, x)
        ks = key_safe(pos)
        prior = man.get(ks) or man.get(kf) or {}
        card = dict(prior, kind="bot", ru=html)
        keys = [kf, ks]
        pair = "%s|%s" % (t.upper(), e)
        # Update an existing alias only; do not introduce ambiguous shortcuts.
        if pair in man and man[pair] == (man.get(ks) or man.get(kf)):
            keys.append(pair)
        if any(man.get(k, {}).get("kind") == "manual" for k in keys):
            continue
        if any(man.get(k) != card for k in keys):
            for k in keys:
                man[k] = card
            written += 1
    _drop_ambiguous_pairs(eq, cr, man)
    return written


def _drop_ambiguous_pairs(eq, cr, man):
    """Delete pair-key aliases (TICKER|entry) shared by >1 sheet trade."""
    import collections

    def cell(r, i):
        return r[i].strip() if i < len(r) and r[i] is not None else ""

    def to_iso(d):
        d = d.strip()
        m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", d)
        return "%s-%s-%s" % (m.group(3), m.group(2).zfill(2), m.group(1).zfill(2)) if m else d
    pair_count = collections.Counter()
    for data in (eq, cr):
        for i in range(3, len(data)):
            r = data[i]
            t = cell(r, 1)
            if not t or t.lower() == "ticker":
                continue
            pair_count[(t.upper(), to_iso(cell(r, 4)))] += 1
    for (t, e), c in pair_count.items():
        if c > 1:
            man.pop("%s|%s" % (t, e), None)
