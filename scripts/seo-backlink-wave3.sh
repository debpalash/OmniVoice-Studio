#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# OmniVoice Studio — Wave 3: Security Scanners & Deep Indexing
# Submits to public security scanners, performance tools, and deep analyzers
# which create publicly indexed report pages for your URL.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SITE_URL="https://github.com/debpalash/OmniVoice-Studio"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SUCCESS=0
FAIL=0
TOTAL=0

submit() {
  local name="$1"; local url="$2"
  TOTAL=$((TOTAL + 1))
  printf "${CYAN}[%3d]${NC} %-45s " "$TOTAL" "$name"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 "$url" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" =~ ^(200|201|202|204|301|302|307|403)$ ]]; then
    printf "${GREEN}✓ %s${NC}\n" "$HTTP_CODE"; SUCCESS=$((SUCCESS + 1))
  else
    printf "${RED}✗ %s${NC}\n" "$HTTP_CODE"; FAIL=$((FAIL + 1))
  fi
}

EU=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_URL', safe=''))")

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  OmniVoice Studio — Wave 3: Scanners & Public Reports          ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. PUBLIC SECURITY SCANNERS (Creates indexed scan reports) ──────────────
echo "${YELLOW}━━━ 1. Security & Malware Scanners ━━━${NC}"
submit "Sucuri SiteCheck"               "https://sitecheck.sucuri.net/results/${SITE_URL}"
submit "VirusTotal Scan URL"            "https://www.virustotal.com/gui/url/$(echo -n $SITE_URL | base64 | tr -d '=' | tr '/+' '_-')/detection"
submit "URLScan.io Search"              "https://urlscan.io/search/#page.url:%22${EU}%22"
submit "Quttera Scanner"                "https://quttera.com/detailed_report/${EU}"
submit "Norton Safe Web"                "https://safeweb.norton.com/report/show?url=${EU}"
submit "Google Safe Browsing"           "https://transparencyreport.google.com/safe-browsing/search?url=${EU}"
submit "ScanURL"                        "https://scanurl.net/?u=${EU}"
submit "TrendMicro Site Safety"         "https://global.sitesafety.trendmicro.com/result.php"
submit "Zscaler Zulu"                   "https://zulu.zscaler.com/submission?url=${EU}"
submit "Hybrid Analysis"                "https://www.hybrid-analysis.com/search?query=${EU}"
submit "Talos Intelligence"             "https://talosintelligence.com/reputation_center/lookup?search=${EU}"
submit "IBM X-Force Exchange"           "https://exchange.xforce.ibmcloud.com/url/${EU}"
submit "AlienVault OTX"                 "https://otx.alienvault.com/indicator/url/${EU}"

# ── 2. WEB PERFORMANCE & TECH ANALYZERS ─────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 2. Performance & Deep Analyzers ━━━${NC}"
submit "Web.dev Measure"                "https://web.dev/measure/?url=${EU}"
submit "Yellow Lab Tools"               "https://yellowlab.tools/result/api/runs?url=${EU}"
submit "Dareboost"                      "https://www.dareboost.com/en/report?url=${EU}"
submit "Dotcom-Monitor"                 "https://www.dotcom-tools.com/website-speed-test?url=${EU}"
submit "Uptrends Speed Test"            "https://www.uptrends.com/tools/website-speed-test?url=${EU}"
submit "Geekflare Speed Test"           "https://geekflare.com/tools/website-speed-test?url=${EU}"
submit "Tools.Pingdom"                  "https://tools.pingdom.com/#5f8d689b94c00000"
submit "Site24x7 Checker"               "https://www.site24x7.com/check-website-availability.html?url=${EU}"
submit "WebSitePulse"                   "https://www.websitepulse.com/tools/website-test?url=${EU}"

# ── 3. HTML / CSS / ACCESSIBILITY VALIDATORS ────────────────────────────────
echo ""
echo "${YELLOW}━━━ 3. W3C & Accessibility Validators ━━━${NC}"
submit "W3C Markup Validator"           "https://validator.w3.org/nu/?doc=${EU}"
submit "W3C CSS Validator"              "https://jigsaw.w3.org/css-validator/validator?uri=${EU}"
submit "W3C Link Checker"               "https://validator.w3.org/checklink?uri=${EU}"
submit "WAVE Accessibility"             "https://wave.webaim.org/report#/${EU}"
submit "AChecker Accessibility"         "https://achecker.ca/checker/index.php?uri=${EU}"
submit "HTML5 Validator"                "https://html5.validator.nu/?doc=${EU}"

# ── SUMMARY ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                  WAVE 3 SUBMISSION RESULTS                      ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
printf "║  Total submissions:  %-40s ║\n" "$TOTAL"
printf "║  ${GREEN}Successful:          %-40s${NC} ║\n" "$SUCCESS"
printf "║  ${RED}Failed/Unreachable:  %-40s${NC} ║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
