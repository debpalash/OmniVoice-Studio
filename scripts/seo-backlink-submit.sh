#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# OmniVoice Studio — Automated SEO Backlink Submission Script
# Programmatically submits to every free, open endpoint that accepts URLs.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SITE_URL="https://github.com/debpalash/OmniVoice-Studio"
SITE_NAME="OmniVoice Studio"
SITE_DESC="Open-source ElevenLabs alternative — cinematic audio dubbing, voice cloning & TTS in 646 languages, runs 100% locally"
RSS_URL="https://github.com/debpalash/OmniVoice-Studio/releases.atom"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SUCCESS=0
FAIL=0
TOTAL=0

submit() {
  local name="$1"
  local url="$2"
  TOTAL=$((TOTAL + 1))
  printf "${CYAN}[%3d]${NC} %-45s " "$TOTAL" "$name"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 "$url" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" =~ ^(200|201|202|204|301|302|307)$ ]]; then
    printf "${GREEN}✓ %s${NC}\n" "$HTTP_CODE"
    SUCCESS=$((SUCCESS + 1))
  else
    printf "${RED}✗ %s${NC}\n" "$HTTP_CODE"
    FAIL=$((FAIL + 1))
  fi
}

submit_post() {
  local name="$1"
  local url="$2"
  local data="$3"
  local content_type="${4:-application/x-www-form-urlencoded}"
  TOTAL=$((TOTAL + 1))
  printf "${CYAN}[%3d]${NC} %-45s " "$TOTAL" "$name"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 \
    -X POST -H "Content-Type: $content_type" -d "$data" "$url" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" =~ ^(200|201|202|204|301|302|307)$ ]]; then
    printf "${GREEN}✓ %s${NC}\n" "$HTTP_CODE"
    SUCCESS=$((SUCCESS + 1))
  else
    printf "${RED}✗ %s${NC}\n" "$HTTP_CODE"
    FAIL=$((FAIL + 1))
  fi
}

ENCODED_URL=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_URL', safe=''))")
ENCODED_NAME=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_NAME', safe=''))")
ENCODED_DESC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_DESC', safe=''))")
ENCODED_RSS=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$RSS_URL', safe=''))")

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  OmniVoice Studio — Automated Backlink Submission Engine    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  URL:  $SITE_URL"
echo "  Name: $SITE_NAME"
echo ""

# ── 1. SEARCH ENGINE INDEXING PINGS ─────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 1. Search Engine Index Pings ━━━${NC}"
submit "Google Ping"                 "https://www.google.com/ping?sitemap=${ENCODED_URL}"
submit "Google Indexing Ping"        "https://www.google.com/webmasters/tools/ping?sitemap=${ENCODED_URL}"
submit "Bing URL Submission"         "https://www.bing.com/ping?sitemap=${ENCODED_URL}"
submit "Bing Webmaster Ping"         "https://www.bing.com/webmaster/ping.aspx?siteMap=${ENCODED_URL}"
submit "Yandex Indexing Ping"        "https://yandex.com/ping?sitemap=${ENCODED_URL}"
submit "Yandex Webmaster Ping"       "https://webmaster.yandex.com/ping?sitemap=${ENCODED_URL}"
submit "Naver Search Ping"           "https://searchadvisor.naver.com/indexnow?url=${ENCODED_URL}"

# ── 2. INDEXNOW PROTOCOL (Instant Indexing) ─────────────────────────────────
echo ""
echo "${YELLOW}━━━ 2. IndexNow Protocol Submissions ━━━${NC}"
# IndexNow is accepted by Bing, Yandex, Seznam, Naver etc.
INDEXNOW_KEY="omnivoice-studio-indexnow-key"
submit "IndexNow → Bing"            "https://www.bing.com/indexnow?url=${ENCODED_URL}&key=${INDEXNOW_KEY}"
submit "IndexNow → Yandex"          "https://yandex.com/indexnow?url=${ENCODED_URL}&key=${INDEXNOW_KEY}"
submit "IndexNow → Seznam"          "https://search.seznam.cz/indexnow?url=${ENCODED_URL}&key=${INDEXNOW_KEY}"
submit "IndexNow → IndexNow.org"    "https://api.indexnow.org/indexnow?url=${ENCODED_URL}&key=${INDEXNOW_KEY}"
submit "IndexNow → Naver"           "https://searchadvisor.naver.com/indexnow?url=${ENCODED_URL}&key=${INDEXNOW_KEY}"

# ── 3. WEB ARCHIVE / CACHE SERVICES ─────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 3. Web Archive & Cache Services ━━━${NC}"
submit "Wayback Machine (save)"      "https://web.archive.org/save/${SITE_URL}"
submit "Archive.today"               "https://archive.ph/?url=${ENCODED_URL}&anyway=1"
submit "Google Cache Ping"           "https://webcache.googleusercontent.com/search?q=cache:${ENCODED_URL}"
submit "Webcitation.org"             "https://www.webcitation.org/archive?url=${ENCODED_URL}"

# ── 4. BLOG / FEED PING SERVICES ────────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 4. Blog & Feed Ping Services ━━━${NC}"

# XML-RPC ping payload
XMLRPC_PING="<?xml version=\"1.0\"?><methodCall><methodName>weblogUpdates.ping</methodName><params><param><value>${SITE_NAME}</value></param><param><value>${SITE_URL}</value></param></params></methodCall>"
XMLRPC_EXT="<?xml version=\"1.0\"?><methodCall><methodName>weblogUpdates.extendedPing</methodName><params><param><value>${SITE_NAME}</value></param><param><value>${SITE_URL}</value></param><param><value>${SITE_URL}</value></param><param><value>${RSS_URL}</value></param></params></methodCall>"

submit_post "Pingomatic"             "https://rpc.pingomatic.com/" "$XMLRPC_PING" "text/xml"
submit_post "Ping-o-Matic (ext)"     "https://rpc.pingomatic.com/" "$XMLRPC_EXT" "text/xml"
submit_post "Twingly Ping"           "https://rpc.twingly.com/" "$XMLRPC_PING" "text/xml"
submit_post "Weblogs.com"            "https://rpc.weblogs.com/RPC2" "$XMLRPC_PING" "text/xml"
submit_post "Blog People"            "http://www.blogpeople.net/ping/" "$XMLRPC_PING" "text/xml"
submit_post "FeedBurner Ping"        "https://ping.feedburner.com/" "$XMLRPC_PING" "text/xml"
submit_post "Moreover Ping"          "https://api.moreover.com/RPC2" "$XMLRPC_PING" "text/xml"
submit_post "Syndic8 Ping"           "https://ping.syndic8.com/xmlrpc.php" "$XMLRPC_PING" "text/xml"
submit_post "BlogRolling Ping"       "https://rpc.blogrolling.com/pinger/" "$XMLRPC_PING" "text/xml"
submit_post "GeoURL Ping"            "http://geourl.org/ping/?p=${ENCODED_URL}" "" ""
submit_post "Pubsubhubbub (Google)"  "https://pubsubhubbub.appspot.com/" "hub.mode=publish&hub.url=${RSS_URL}"
submit_post "Superfeedr"             "https://push.superfeedr.com/" "hub.mode=publish&hub.url=${RSS_URL}"

# ── 5. PINGOMATIC COMPREHENSIVE (hits 20+ services at once) ────────────────
echo ""
echo "${YELLOW}━━━ 5. Pingomatic Multi-Service Blast ━━━${NC}"
PINGO_PARAMS="title=${ENCODED_NAME}&blogurl=${ENCODED_URL}&rssurl=${ENCODED_RSS}"
PINGO_PARAMS+="&chk_blogs=on&chk_feedburner=on&chk_newsgator=on"
PINGO_PARAMS+="&chk_feedster=on&chk_syndic8=on&chk_blogrolling=on"
PINGO_PARAMS+="&chk_topicexchange=on&chk_google=on&chk_tailrank=on"
PINGO_PARAMS+="&chk_blogstreet=on&chk_moreover=on&chk_icerocket=on"
PINGO_PARAMS+="&chk_newsisfree=on&chk_blogdigger=on&chk_weblogalot=on"
PINGO_PARAMS+="&chk_blogosphere=on&chk_blo_gs=on&chk_technorati=on"
PINGO_PARAMS+="&chk_pingmyblog=on&chk_bloglines=on"
submit_post "Pingomatic (all services)" "https://pingomatic.com/ping/?${PINGO_PARAMS}" ""

# ── 6. SOCIAL BOOKMARKING & LINK AGGREGATION ────────────────────────────────
echo ""
echo "${YELLOW}━━━ 6. Social Bookmarking & Link Shorteners ━━━${NC}"
submit "Reddit Share URL"            "https://www.reddit.com/submit?url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "HN Submit URL"               "https://news.ycombinator.com/submitlink?u=${ENCODED_URL}&t=${ENCODED_NAME}"
submit "Lobsters Submit URL"         "https://lobste.rs/stories/new?url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Mix.com Share"               "https://mix.com/add?url=${ENCODED_URL}"
submit "Pocket Save"                 "https://getpocket.com/save?url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Flipboard Share"             "https://share.flipboard.com/bookmarklet/popout?v=2&url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Diigo Bookmark"              "https://www.diigo.com/post?url=${ENCODED_URL}&title=${ENCODED_NAME}&desc=${ENCODED_DESC}"
submit "Instapaper Save"             "https://www.instapaper.com/hello2?url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Raindrop.io Save"            "https://app.raindrop.io/add?link=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Folkd Bookmark"              "http://www.folkd.com/submit.php?url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Slashdot Submit"             "https://slashdot.org/bookmark.pl?url=${ENCODED_URL}&title=${ENCODED_NAME}"
submit "Symbaloo Add"                "https://www.symbaloo.com/mix/submit?url=${ENCODED_URL}"
submit "Pearltrees Add"              "https://www.pearltrees.com/s/save?url=${ENCODED_URL}&title=${ENCODED_NAME}"

# ── 7. DEVELOPER / TECH-SPECIFIC ────────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 7. Developer & Tech Platforms ━━━${NC}"
submit "LibHunt Lookup"              "https://www.libhunt.com/r/OmniVoice-Studio"
submit "StackShare Lookup"           "https://stackshare.io/omnivoice-studio"
submit "DevHunt Submit"              "https://devhunt.org/submit?url=${ENCODED_URL}"
submit "OSS Insight Lookup"          "https://ossinsight.io/analyze/debpalash/OmniVoice-Studio"
submit "Star History"                "https://star-history.com/#debpalash/OmniVoice-Studio"
submit "GitTrends"                   "https://gittrends.io/repo/debpalash/OmniVoice-Studio"
submit "RepoTracker"                 "https://repo-tracker.com/r/gh/debpalash/OmniVoice-Studio"
submit "Snyk Advisor"                "https://snyk.io/advisor/python/omnivoice"
submit "Libraries.io"                "https://libraries.io/github/debpalash/OmniVoice-Studio"
submit "OpenHub"                     "https://www.openhub.net/p/OmniVoice-Studio"
submit "Awesome Self-Hosted"         "https://awesome-selfhosted.net/"
submit "RunaCapital ROSS Index"      "https://runacap.com/ross-index/"
submit "SaaSHub Lookup"              "https://www.saashub.com/omnivoice-studio"

# ── 8. AI / ML TOOL DIRECTORIES ─────────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 8. AI & ML Tool Directories ━━━${NC}"
submit "There's An AI For That"      "https://theresanaiforthat.com/submit/?url=${ENCODED_URL}"
submit "Futurepedia Submit"          "https://www.futurepedia.io/submit-tool"
submit "FutureTools Submit"          "https://www.futuretools.io/submit-a-tool"
submit "Toolify Submit"              "https://www.toolify.ai/submit"
submit "AI Tool Directory"           "https://aitoolsdirectory.com/submit"
submit "TopAI.tools"                 "https://topai.tools/submit"
submit "AIcyclopedia"                "https://www.aicyclopedia.com/submit"
submit "Dang AI"                     "https://dang.ai/submit"
submit "Ben's Bites Directory"       "https://news.bensbites.co/submit"
submit "AI Tools List"               "https://aitoolslist.io/submit"
submit "All Things AI"               "https://allthingsai.com/submit"
submit "FindMyAITool"                "https://findmyaitool.com/submit"
submit "AI Tool Guru"                "https://aitoolguru.com/submit"
submit "Easy With AI"                "https://easywithai.com/submit"
submit "Insidr AI"                   "https://www.insidr.ai/submit-tool/"
submit "AItoolsguide"                "https://www.aitoolsguide.com/submit"
submit "GPT Store (alt)"             "https://gptstore.ai/submit"

# ── 9. STARTUP / SOFTWARE DIRECTORIES ───────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 9. Startup & Software Directories ━━━${NC}"
submit "AlternativeTo Lookup"        "https://alternativeto.net/software/omnivoice-studio/"
submit "Slant Lookup"                "https://www.slant.co/search?query=omnivoice+studio"
submit "G2 Submit"                   "https://www.g2.com/products/new"
submit "Capterra Submit"             "https://www.capterra.com/vendors/sign-up"
submit "GetApp Lookup"               "https://www.getapp.com/search/?q=omnivoice+studio"
submit "SoftwareAdvice"              "https://www.softwareadvice.com/search/?q=omnivoice+studio"
submit "Crunchbase Lookup"           "https://www.crunchbase.com/discover/organization.companies"
submit "BetaList Submit"             "https://betalist.com/submit"
submit "BetaPage Submit"             "https://betapage.co/submit"
submit "Launching Next Submit"       "https://www.launchingnext.com/submit/"
submit "StartupBase Submit"          "https://startupbase.io/submit"
submit "DiscoverCloud"               "https://www.discovercloud.com/submit"
submit "SideProjectors"              "https://www.sideprojectors.com/"
submit "MicroLaunch"                 "https://microlaunch.net/submit"
submit "Uneed"                       "https://www.uneed.best/submit"
submit "Landingfolio"                "https://www.landingfolio.com/submit"
submit "1000 Tools"                  "https://1000.tools/submit"
submit "Startup Stash"               "https://startupstash.com/submit/"
submit "SaaSWorthy"                  "https://www.saasworthy.com/submit"
submit "Tekpon Submit"               "https://tekpon.com/get-listed/"
submit "AppSumo Marketplace"         "https://sell.appsumo.com/"
submit "SaaS Genius"                 "https://www.saasgenius.com/submit"

# ── 10. WEB DIRECTORIES (Classic backlink sources) ──────────────────────────
echo ""
echo "${YELLOW}━━━ 10. Web Directories (Classic SEO) ━━━${NC}"
submit "BOTW (Best of the Web)"      "https://botw.org/helpcenter/submitasite/"
submit "Jayde"                       "https://www.jayde.com/submit.html"
submit "Spoke.com"                   "https://www.spoke.com/"
submit "Hotfrog"                     "https://www.hotfrog.com/AddYourBusiness/"
submit "eLocal"                      "https://www.elocal.com/"
submit "Cylex"                       "https://www.cylex.com/"
submit "Brownbook"                   "https://www.brownbook.net/add-listing/"
submit "Tupalo"                      "https://www.tupalo.co/free-entry"
submit "OpenLinkDirectory"           "https://www.openlinks.org/submit"
submit "SoMuch Directory"            "https://www.somuch.com/submit-links/"
submit "Alive Directory"             "https://www.alivedirectory.com/submit.php"
submit "9Sites"                      "https://www.9sites.net/addurl.php"
submit "One Mission Directory"       "https://www.onemission.com/"
submit "Cipinet Directory"           "https://www.cipinet.com/addurl/"

# ── 11. LINK SHORTENERS (creates indexed short URLs) ────────────────────────
echo ""
echo "${YELLOW}━━━ 11. Link Shorteners (indexed short links) ━━━${NC}"
submit "TinyURL"                     "https://tinyurl.com/api-create.php?url=${ENCODED_URL}"
submit "is.gd"                       "https://is.gd/create.php?format=simple&url=${ENCODED_URL}"
submit "v.gd"                        "https://v.gd/create.php?format=simple&url=${ENCODED_URL}"
submit "clck.ru (Yandex)"            "https://clck.ru/--?url=${ENCODED_URL}"
submit "da.gd"                       "https://da.gd/s?url=${ENCODED_URL}"
submit "short.io Lookup"             "https://short.io/"

# ── 12. WHOIS / DOMAIN LOOKUP CACHES ────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 12. WHOIS & Domain Lookup Caches ━━━${NC}"
submit "W3Techs"                     "https://w3techs.com/sites/info/github.com"
submit "BuiltWith"                   "https://builtwith.com/debpalash.github.io"
submit "Netcraft Site Report"        "https://sitereport.netcraft.com/?url=${ENCODED_URL}"
submit "SimilarWeb"                  "https://www.similarweb.com/website/github.com/debpalash/OmniVoice-Studio/"
submit "Wappalyzer"                  "https://www.wappalyzer.com/lookup/${SITE_URL}/"
submit "SecurityHeaders"             "https://securityheaders.com/?q=${ENCODED_URL}&followRedirects=on"
submit "Mozilla Observatory"         "https://observatory.mozilla.org/analyze/${SITE_URL}"
submit "SSL Labs"                    "https://www.ssllabs.com/ssltest/analyze.html?d=github.com"

# ── 13. ADDITIONAL PAGES TO INDEX ────────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 13. Additional Pages to Index ━━━${NC}"
PAGES=(
  "https://github.com/debpalash/OmniVoice-Studio"
  "https://github.com/debpalash/OmniVoice-Studio/releases"
  "https://github.com/debpalash/OmniVoice-Studio/wiki"
  "https://github.com/debpalash/OmniVoice-Studio/issues"
  "https://github.com/debpalash/OmniVoice-Studio/pulls"
  "https://github.com/debpalash/OmniVoice-Studio/blob/main/README.md"
  "https://github.com/debpalash/OmniVoice-Studio/blob/main/ROADMAP.md"
  "https://github.com/debpalash/OmniVoice-Studio/releases/tag/v0.2.4"
)
for page in "${PAGES[@]}"; do
  EPAGE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$page', safe=''))")
  submit "Wayback: $(basename $page)" "https://web.archive.org/save/${page}"
  submit "Google Ping: $(basename $page)" "https://www.google.com/ping?sitemap=${EPAGE}"
done

# ── SUMMARY ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                     SUBMISSION RESULTS                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  Total submissions:  %-38s ║\n" "$TOTAL"
printf "║  ${GREEN}Successful:          %-38s${NC} ║\n" "$SUCCESS"
printf "║  ${RED}Failed/Unreachable:  %-38s${NC} ║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "💡 Tips for maximum SEO impact:"
echo "   • Run this script weekly to keep pings fresh"
echo "   • Sites marked ✗ may need manual submission (login required)"
echo "   • Add cron: 0 9 * * 1 bash $(realpath $0)"
echo ""
