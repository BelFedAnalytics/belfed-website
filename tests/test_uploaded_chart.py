import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/"scripts"))
import ru_card_build as B

def test_uploaded_chart_and_source_link():
    image="https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/position-chart-media?id=10000000-0000-0000-0000-000000000001"
    p={"ticker":"BTC","direction":"long","opened_at":"2026-09-01","closed_at":"2026-10-01","result_rr":1,
       "events":[{"event_type":"closed","triggered_at":"2026-10-01","message_id_ru":2,
       "chart_image_url":image,"chart_url":"https://www.tradingview.com/x/ABC123/","payload":{}}],
       "partial_closes":[]}
    h=B.build_card(p,{})
    assert 'src="'+image+'"' in h
    assert 'href="https://www.tradingview.com/x/ABC123/"' in h
