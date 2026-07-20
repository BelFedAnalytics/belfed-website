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

RU_CHANNEL = "3773738299"
RU_TOPIC = "4"
PROMO = ('<div class="promo"><span class="promo-h">Следите за сделками BelFed в '
         'реальном времени</span><p class="promo-body">Оформите 14-дневный '
         'бесплатный доступ, чтобы получать профессиональную аналитику и '
         'моментальные оповещения о торговых идеях и наших сделках.</p>'
         '<a class="promo-btn" href="https://belfed.ru/ru/trial.html?source='
         'trial_tradehistory_modal_ru" data-cta="trial">Оформить бесплатный '
         '14-дневный доступ ↗</a></div>')
BOT_INTRO = ("Ниже представлены сообщения, опубликованные в подписной группе "
             "в течение жизненного цикла этой сделки.")
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


def step_body(pos, ev, pc_by_id):
    """Body HTML for a published event step (already escaped).

    Stored subscriber text is verbatim; only fabricated price sentences are
    de-anglicized.
    """
    et = ev.get("event_type")
    pl = ev.get("payload") or {}
    price = num(pl.get("triggered_price"))
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
    if et == "partial_closed":
        pc = pc_by_id.get(pl.get("partial_close_id"))
        if pc:
            if pc.get("comment_ru"):
                return stored(pc["comment_ru"])
            return gen("Закрыто %s%% по %s."
                       % (num(pc.get("pct_closed")), num(pc.get("exit_price"))))
        return ""
    if et in TARGET_LABEL:
        return gen("%s по %s." % (TARGET_LABEL[et], num(pl.get("triggered_price"))))
    if et == "stop_hit":
        return gen("Стоп сработал по %s." % num(pl.get("triggered_price")))
    if et == "closed":
        if pos.get("close_comment_ru"):
            return stored(pos["close_comment_ru"])
        if pl.get("comment_ru"):
            return stored(pl["comment_ru"])
        return gen("Закрыто по %s." % num(pl.get("triggered_price")))
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
        "edited": "Обновление",
    }.get(et, TARGET_LABEL.get(et, et))


def _step_html(label, ts, body, link=""):
    return ('<li class="step"><div class="step-h"><span class="step-lbl">%s</span>'
            '<span class="step-ts">%s</span></div><div class="step-body">%s</div>%s</li>'
            % (esc(label), esc(ts), body, link))


def _signal_link(message_id_ru):
    href = "https://t.me/c/%s/%s/%s" % (RU_CHANNEL, RU_TOPIC, message_id_ru)
    return ('<a class="steplink" href="%s" target="_blank" rel="noopener">%s %s</a>'
            % (href, LOCK_SVG, SIGNAL_LABEL))


def _wrap(pos, steps):
    """Assemble the card shell around a list of <li> step strings."""
    if not steps:
        return None
    rr = pos.get("result_rr")
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
    """Path A: published, event-driven -- one linked step per published event."""
    steps = []
    for ev in events:
        body = step_body(pos, ev, pc_by_id)
        ts = dd(ev.get("triggered_at")) or dd(pos.get("opened_at"))
        steps.append(_step_html(step_label(ev), ts, body,
                                _signal_link(ev["message_id_ru"])))
    return _wrap(pos, steps)


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
        if pc.get("comment_ru"):
            body = stored(pc["comment_ru"])
        else:
            body = gen("Закрыто %s%% по %s."
                       % (num(pc.get("pct_closed")), num(pc.get("exit_price"))))
        steps.append(_step_html("Частичное закрытие", dd(pc.get("closed_at")), body))

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
    the EN build). Existing hand-tuned bot cards are never clobbered. Ambiguous
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
        html = build_card(pos, pc_by_id)
        if not html:
            continue
        t, e, x = pos["ticker"], iso(pos["opened_at"]), iso(pos["closed_at"])
        card = {"kind": "bot", "ru": html}
        kf = key_full(t, e, x)
        # Never clobber an approved hand-tuned bot card on the full key.
        if man.get(kf, {}).get("kind") != "bot":
            man[kf] = card
            written += 1
        # Collision-safe alias mirrors the authoritative full-key card, so it
        # never shadows a hand-tuned card with the freshly built one.
        man[key_safe(pos)] = man.get(kf, card)
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
