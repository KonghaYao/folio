"""Mount the real editor + MCP server in headless Chromium, measure JSON-RPC latency."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument('--count', type=int, default=50_000)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--chromium', default=os.environ.get('FOLIO_CHROMIUM'))
args = parser.parse_args()
source = args.source.resolve()
scenario = Path(__file__).with_name('scenario.ts')
with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
    bundle = Path(tmp) / 'scenario.js'
    subprocess.run([str(source / 'node_modules/.bin/esbuild'), str(scenario), '--bundle',
                    '--global-name=boardBenchmark', '--format=iife', '--loader:.css=empty', '--external:*?url',
                    '--define:process.env.NODE_ENV="production"', '--log-level=error', '--define:import.meta.env.PROD=true',
                    f'--alias:@folio={source / "client"}', f'--outfile={bundle}'], cwd=source, check=True)
    browser = pw.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1200,'height':800})
    headers={'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'}
    def serve(route):
        if route.request.url.endswith('/scenario.js'):
            route.fulfill(body=bundle.read_bytes(), content_type='text/javascript', headers=headers)
        else:
            route.fulfill(body='<body style="margin:0"><script src="/scenario.js"></script></body>', content_type='text/html', headers=headers)
    page.on('pageerror',lambda error: print(f'Browser error: {error}'))
    page.route('http://localhost:8181/**', serve)
    page.goto('http://localhost:8181/')
    result=page.evaluate('(count) => boardBenchmark.run(count)', args.count)
    result['chromiumVersion']=browser.version
    browser.close()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
