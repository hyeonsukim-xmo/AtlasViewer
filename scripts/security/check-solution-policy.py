"""Shared JS/Python decisions; test driver, never distributed."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
from solution_security import allowed

cases = json.load(sys.stdin)
result = []
for case in cases:
    try:
        allowed(case['lease'], case['execution'], case['now'])
        result.append(True)
    except Exception:
        result.append(False)
print(json.dumps(result))
