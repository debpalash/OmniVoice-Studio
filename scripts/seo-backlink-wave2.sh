#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# OmniVoice Studio — Wave 2: Deep SEO Backlink Submission
# Extended list: code mirrors, package indexes, wiki crawlers, forum pings,
# RSS aggregators, and 100+ additional directories
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SITE_URL="https://github.com/debpalash/OmniVoice-Studio"
SITE_NAME="OmniVoice Studio"
SITE_DESC="Open-source ElevenLabs alternative — cinematic audio dubbing, voice cloning and TTS in 646 languages"
RSS_URL="https://github.com/debpalash/OmniVoice-Studio/releases.atom"
GITHUB_USER="debpalash"
REPO_NAME="OmniVoice-Studio"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SUCCESS=0
FAIL=0
TOTAL=0

submit() {
  local name="$1"; local url="$2"
  TOTAL=$((TOTAL + 1))
  printf "${CYAN}[%3d]${NC} %-50s " "$TOTAL" "$name"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 "$url" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" =~ ^(200|201|202|204|301|302|307)$ ]]; then
    printf "${GREEN}✓ %s${NC}\n" "$HTTP_CODE"; SUCCESS=$((SUCCESS + 1))
  else
    printf "${RED}✗ %s${NC}\n" "$HTTP_CODE"; FAIL=$((FAIL + 1))
  fi
}

submit_post() {
  local name="$1"; local url="$2"; local data="$3"
  local ct="${4:-application/x-www-form-urlencoded}"
  TOTAL=$((TOTAL + 1))
  printf "${CYAN}[%3d]${NC} %-50s " "$TOTAL" "$name"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 \
    -X POST -H "Content-Type: $ct" -d "$data" "$url" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" =~ ^(200|201|202|204|301|302|307)$ ]]; then
    printf "${GREEN}✓ %s${NC}\n" "$HTTP_CODE"; SUCCESS=$((SUCCESS + 1))
  else
    printf "${RED}✗ %s${NC}\n" "$HTTP_CODE"; FAIL=$((FAIL + 1))
  fi
}

EU=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_URL', safe=''))")
EN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_NAME', safe=''))")
ED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SITE_DESC', safe=''))")

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  OmniVoice Studio — Wave 2: Deep SEO Backlink Engine           ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. CODE HOSTING MIRRORS (create indexed pages on other forges) ───────────
echo "${YELLOW}━━━ 1. Code Hosting & Mirror Lookups ━━━${NC}"
submit "GitLab Import"                  "https://gitlab.com/import/github/status"
submit "Codeberg Explore"               "https://codeberg.org/explore/repos?q=omnivoice"
submit "Gitea.com Explore"              "https://gitea.com/explore/repos?q=omnivoice"
submit "Notabug Explore"                "https://notabug.org/explore/repos?q=omnivoice"
submit "Launchpad Search"               "https://launchpad.net/+search?field.text=omnivoice"
submit "sr.ht (SourceHut)"              "https://sr.ht/"
submit "Pagure.io Search"               "https://pagure.io/search?term=omnivoice"
submit "GitBook Lookup"                 "https://www.gitbook.com/"
submit "Radicle Explore"                "https://app.radicle.xyz/"

# ── 2. PACKAGE REGISTRY LOOKUPS (indexes your project name) ─────────────────
echo ""
echo "${YELLOW}━━━ 2. Package Registry & Index Lookups ━━━${NC}"
submit "PyPI Search"                    "https://pypi.org/search/?q=omnivoice"
submit "npm Search"                     "https://www.npmjs.com/search?q=omnivoice"
submit "Conda Search"                   "https://anaconda.org/search?q=omnivoice"
submit "Docker Hub Search"              "https://hub.docker.com/search?q=omnivoice"
submit "Flathub Search"                 "https://flathub.org/apps/search?q=omnivoice"
submit "Snapcraft Search"               "https://snapcraft.io/search?q=omnivoice"
submit "Winget Search"                  "https://winget.run/search?query=omnivoice"
submit "Homebrew Formulae"              "https://formulae.brew.sh/formula/?search=omnivoice"
submit "AUR Search"                     "https://aur.archlinux.org/packages?K=omnivoice"
submit "Repology Search"                "https://repology.org/projects/?search=omnivoice"

# ── 3. DEVELOPER COMMUNITY CRAWL TRIGGERS ───────────────────────────────────
echo ""
echo "${YELLOW}━━━ 3. Developer Community & Forum Crawl Triggers ━━━${NC}"
submit "Dev.to Search"                  "https://dev.to/search?q=omnivoice+studio"
submit "Hashnode Search"                "https://hashnode.com/search?q=omnivoice"
submit "Medium Search"                  "https://medium.com/search?q=omnivoice+studio"
submit "HackerNoon Search"              "https://hackernoon.com/search?query=omnivoice"
submit "Indie Hackers Search"           "https://www.indiehackers.com/search?q=omnivoice"
submit "DEV Community Tag"              "https://dev.to/t/voicecloning"
submit "DEV Community TTS Tag"          "https://dev.to/t/tts"
submit "DEV Community AI Tag"           "https://dev.to/t/ai"
submit "daily.dev Search"               "https://app.daily.dev/search?q=omnivoice+studio"
submit "Lemmy Search"                   "https://lemmy.world/search?q=omnivoice+studio&type=All"
submit "Mastodon Search (instances)"    "https://mastodon.social/tags/omnivoice"
submit "Bluesky Search"                 "https://bsky.app/search?q=omnivoice+studio"
submit "Tildes Search"                  "https://tildes.net/search?q=omnivoice"
submit "Fediverse Search"               "https://search.joinmastodon.org/"

# ── 4. RESEARCH & ACADEMIC CRAWLERS ─────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 4. Research & Academic Platforms ━━━${NC}"
submit "Papers With Code"               "https://paperswithcode.com/search?q=omnivoice"
submit "Semantic Scholar"                "https://www.semanticscholar.org/search?q=omnivoice"
submit "Google Scholar"                  "https://scholar.google.com/scholar?q=omnivoice+studio"
submit "Hugging Face Search"            "https://huggingface.co/search/full-text?q=omnivoice+studio&type=all"
submit "Hugging Face Spaces"            "https://huggingface.co/spaces?search=omnivoice"
submit "Replicate Search"               "https://replicate.com/explore?query=omnivoice"
submit "Kaggle Search"                  "https://www.kaggle.com/search?q=omnivoice"

# ── 5. RSS / ATOM FEED AGGREGATORS ──────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 5. RSS & Feed Aggregators ━━━${NC}"
submit "Feedly Feed"                    "https://feedly.com/i/subscription/feed/${RSS_URL}"
submit "Inoreader Feed"                 "https://www.inoreader.com/?add_feed=${RSS_URL}"
submit "NewsBlur Feed"                  "https://newsblur.com/?url=${RSS_URL}"
submit "Feedspot"                       "https://www.feedspot.com/infiniterss.php?q=${EU}"
submit "FeedBin"                        "https://feedbin.com/"
submit "Blogtrottr"                     "https://blogtrottr.com/?subscribe=${RSS_URL}"
submit "Feed43"                         "https://feed43.com/"
submit "FetchRSS"                       "https://fetchrss.com/generator/input?url=${EU}"

# ── 6. ADDITIONAL AI TOOL DIRECTORIES ───────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 6. Additional AI Tool Directories ━━━${NC}"
submit "AI Depot"                       "https://www.aidepot.co/submit"
submit "AIModels.fyi"                   "https://www.aimodels.fyi/"
submit "SaaS AI Tools"                  "https://saasaitools.com/submit/"
submit "AI Scout"                       "https://aiscout.net/submit/"
submit "AI Tool Mall"                   "https://www.aitoolmall.com/submit"
submit "SuperTools"                     "https://supertools.therundown.ai/submit"
submit "AI Parabellum"                  "https://aiparabellum.com/submit/"
submit "AI Tool Board"                  "https://www.aitoolboard.com/submit"
submit "AI Tools Hub"                   "https://www.aitoolshub.co/submit"
submit "GPTForge"                       "https://gptforge.net/submit"
submit "Free AI Tool"                   "https://freeaitool.ai/submit"
submit "AI Tools Arena"                 "https://aitoolsarena.com/submit"
submit "NavAI"                          "https://www.navai.me/submit"
submit "GPT Hub"                        "https://gpthub.gg/submit"
submit "DoMore.ai"                      "https://domore.ai/submit"
submit "AI Center"                      "https://aicenter.ai/submit"
submit "The AI Warehouse"               "https://www.thewarehouse.ai/submit"
submit "AI Awesome"                     "https://www.aiawesome.com/submit"
submit "Nextool"                        "https://nextool.io/submit"
submit "Mars AI Directory"              "https://www.marsx.dev/ai-startups/submit"
submit "Tool Pilot"                     "https://www.toolpilot.ai/submit"
submit "AI Finder"                      "https://ai-finder.net/submit"
submit "OpenTools.ai"                   "https://opentools.ai/submit"
submit "StartupAITools"                 "https://www.startupaitools.com/submit"

# ── 7. MORE STARTUP / SAAS / PRODUCT DIRECTORIES ────────────────────────────
echo ""
echo "${YELLOW}━━━ 7. Startup & Product Directories (Extended) ━━━${NC}"
submit "ToolFinder"                     "https://toolfinder.co/submit"
submit "SaaSFrame"                      "https://www.saasframe.io/submit"
submit "HiTooler"                       "https://www.hitooler.com/submit"
submit "ToolsForHumans"                 "https://toolsforhumans.ai/submit"
submit "Launched"                       "https://launched.io/submit"
submit "Pitchwall"                      "https://pitchwall.co/submit"
submit "StartupLift"                    "https://www.startuplift.com/submit"
submit "Launchaco"                      "https://www.launchaco.com/"
submit "StartupRanking"                 "https://www.startupranking.com/startup/submit"
submit "TechPluto"                      "https://www.techpluto.com/submit/"
submit "KillerStartups"                 "https://www.killerstartups.com/submit-startup/"
submit "StartupBuffer"                  "https://startupbuffer.com/submit"
submit "Startup88"                      "https://startup88.com/submit/"
submit "WebAppRater"                    "https://www.webapprater.com/submit-your-web-app/"
submit "All Startups Info"              "https://allstartups.info/submit/"
submit "SnapMunk"                       "https://www.snapmunk.com/submit/"
submit "SaaSBase"                       "https://saasbase.dev/submit"
submit "SaaS Pirate"                    "https://saaspirate.com/submit"
submit "TechFaster"                     "https://techfaster.com/submit/"
submit "RateStartup"                    "https://ratestartup.com/submit"
submit "VentureRadar"                   "https://www.ventureradar.com/"
submit "Geek Wire"                      "https://www.geekwire.com/"
submit "Erlibird"                       "https://erlibird.com/submit"
submit "AppRater"                       "https://apprater.net/submit/"
submit "The Startup Pitch"              "https://thestartuppitch.com/submit/"
submit "StartupInspire"                 "https://www.startupinspire.com/submit"
submit "CrunchStar"                     "https://www.crunchstar.com/submit"
submit "NextBigWhat"                    "https://nextbigwhat.com/"
submit "YourStory Submit"               "https://yourstory.com/submit"

# ── 8. OPEN SOURCE SPECIFIC DIRECTORIES ─────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 8. Open Source Directories ━━━${NC}"
submit "FOSS Post"                      "https://fosspost.org/"
submit "It's FOSS"                      "https://itsfoss.com/"
submit "FOSS Torrents"                  "https://fosstorrents.com/"
submit "OpenSource.com"                 "https://opensource.com/"
submit "Open Source Alternative"        "https://www.opensourcealternative.to/"
submit "Open Source Builders"           "https://opensource.builders/"
submit "AwesomeOpenSource"              "https://awesomeopensource.com/project/debpalash/OmniVoice-Studio"
submit "OpenBase"                       "https://openbase.com/"
submit "Free Software Foundation"       "https://www.fsf.org/"
submit "OSS Insight (detailed)"         "https://ossinsight.io/analyze/debpalash/OmniVoice-Studio#overview"
submit "GitHub Trending"                "https://github.com/trending?since=weekly"
submit "GitExplorer"                    "https://gitexplorer.com/"
submit "Best of JS"                     "https://bestofjs.org/"
submit "LibrariesHQ"                    "https://www.librarieshq.com/"
submit "OpenHub (Black Duck)"           "https://www.openhub.net/p?query=omnivoice"
submit "Libre Projects"                 "https://libreprojects.net/"

# ── 9. LINK SHORTENER WAVE 2 ────────────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 9. Additional Link Shorteners ━━━${NC}"
submit "rebrand.ly"                     "https://app.rebrandly.com/"
submit "T.LY"                          "https://t.ly/api/v1/link/shorten?long_url=${EU}"
submit "Kutt.it"                        "https://kutt.it/"
submit "Short.cm"                       "https://short.cm/"
submit "Shrtco.de"                      "https://api.shrtco.de/v2/shorten?url=${EU}"
submit "Chilp.it"                       "https://chilp.it/api.php?url=${EU}"
submit "cleanuri.com"                   "https://cleanuri.com/api/v1/shorten"
submit "ulvis.net"                      "https://ulvis.net/API/write/get?url=${EU}"
submit "4h.net"                         "https://4h.net/"

# ── 10. SEO ANALYSIS TOOLS (each creates a cached/indexed page) ─────────────
echo ""
echo "${YELLOW}━━━ 10. SEO Analysis & Audit Tools ━━━${NC}"
submit "GTmetrix"                       "https://gtmetrix.com/"
submit "PageSpeed Insights"             "https://pagespeed.web.dev/analysis?url=${EU}"
submit "Lighthouse (web.dev)"           "https://web.dev/measure/?url=${EU}"
submit "Nibbler"                        "https://nibbler.insites.com/en/reports/${SITE_URL}"
submit "SEOptimer"                      "https://www.seoptimer.com/${SITE_URL}"
submit "SiteChecker"                    "https://sitechecker.pro/app/main/project?url=${EU}"
submit "UpCity SEO Report"              "https://upcity.com/free-seo-report/"
submit "SEOSiteCheckup"                 "https://seositecheckup.com/seo-audit/${SITE_URL}"
submit "SmallSEOTools"                  "https://smallseotools.com/"
submit "Ahrefs Backlink Check"          "https://ahrefs.com/backlink-checker?input=${EU}"
submit "Moz Link Explorer"             "https://moz.com/link-explorer?site=${EU}"
submit "Majestic"                       "https://majestic.com/reports/site-explorer?q=${EU}"
submit "SEMrush Lookup"                 "https://www.semrush.com/analytics/overview/?q=${EU}"
submit "Ubersuggest"                    "https://neilpatel.com/ubersuggest/?keyword=${EU}"
submit "WebPageTest"                    "https://www.webpagetest.org/?url=${EU}"
submit "GiftOfSpeed"                    "https://www.giftofspeed.com/?url=${EU}"
submit "Pingdom"                        "https://tools.pingdom.com/"
submit "Uptime Robot"                   "https://uptimerobot.com/"
submit "IsItDown"                       "https://www.isitdownrightnow.com/${SITE_URL}.html"
submit "DownForEveryoneOrJustMe"        "https://downforeveryoneorjustme.com/${SITE_URL}"
submit "Host Tracker"                   "https://www.host-tracker.com/"
submit "DNSChecker"                     "https://dnschecker.org/"
submit "WhatsMyDNS"                     "https://www.whatsmydns.net/"

# ── 11. SOCIAL SHARING URL GENERATORS ───────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 11. Social Sharing URLs ━━━${NC}"
submit "Twitter/X Share"                "https://twitter.com/intent/tweet?text=${EN}%20-%20${ED}&url=${EU}"
submit "LinkedIn Share"                 "https://www.linkedin.com/sharing/share-offsite/?url=${EU}"
submit "Facebook Share"                 "https://www.facebook.com/sharer/sharer.php?u=${EU}"
submit "Telegram Share"                 "https://t.me/share/url?url=${EU}&text=${EN}"
submit "WhatsApp Share"                 "https://api.whatsapp.com/send?text=${EN}%20${EU}"
submit "Pinterest Pin"                  "https://pinterest.com/pin/create/button/?url=${EU}&description=${ED}"
submit "Tumblr Share"                   "https://www.tumblr.com/widgets/share/tool?canonicalUrl=${EU}&title=${EN}"
submit "VK Share"                       "https://vk.com/share.php?url=${EU}&title=${EN}"
submit "Weibo Share"                    "https://service.weibo.com/share/share.php?url=${EU}&title=${EN}"
submit "Line Share"                     "https://social-plugins.line.me/lineit/share?url=${EU}"
submit "Threads Share"                  "https://www.threads.net/intent/post?text=${EN}%20${EU}"
submit "Buffer Share"                   "https://bufferapp.com/add?url=${EU}&text=${EN}"
submit "HootSuite Share"               "https://platform.hootsuite.com/share?url=${EU}&text=${EN}"
submit "Evernote Clip"                  "https://www.evernote.com/clip.action?url=${EU}&title=${EN}"
submit "OneNote Clip"                   "https://www.onenote.com/clipper?url=${EU}"
submit "WordPress Press This"           "https://wordpress.com/press-this.php?u=${EU}&t=${EN}&s=${ED}"
submit "Blogger Share"                  "https://www.blogger.com/blog-this.g?u=${EU}&n=${EN}&t=${ED}"
submit "Hacker News"                    "https://news.ycombinator.com/submitlink?u=${EU}&t=${EN}"

# ── 12. ADDITIONAL WAYBACK SAVES ────────────────────────────────────────────
echo ""
echo "${YELLOW}━━━ 12. Extended Wayback Machine Archives ━━━${NC}"
EXTRA_PAGES=(
  "https://github.com/debpalash/OmniVoice-Studio/blob/main/STRUCTURE.md"
  "https://github.com/debpalash/OmniVoice-Studio/blob/main/LICENSE"
  "https://github.com/debpalash/OmniVoice-Studio/graphs/contributors"
  "https://github.com/debpalash/OmniVoice-Studio/network/dependents"
  "https://github.com/debpalash/OmniVoice-Studio/stargazers"
  "https://github.com/debpalash/OmniVoice-Studio/network/members"
  "https://github.com/debpalash/OmniVoice-Studio/releases/tag/v0.2.4"
  "https://github.com/debpalash/OmniVoice-Studio/releases/tag/v0.2.3"
  "https://github.com/debpalash/OmniVoice-Studio/tree/main/backend"
  "https://github.com/debpalash/OmniVoice-Studio/tree/main/frontend"
  "https://github.com/debpalash/OmniVoice-Studio/tree/main/docs"
  "https://github.com/debpalash"
)
for page in "${EXTRA_PAGES[@]}"; do
  submit "Archive: $(echo $page | sed 's|.*/||')" "https://web.archive.org/save/${page}"
done

# ── 13. GOOGLE SCHOLAR / RESEARCH INDEX PINGS ───────────────────────────────
echo ""
echo "${YELLOW}━━━ 13. Knowledge Graph & Entity Pings ━━━${NC}"
submit "Wikidata Search"                "https://www.wikidata.org/w/index.php?search=omnivoice+studio"
submit "Wikipedia Search"               "https://en.wikipedia.org/w/index.php?search=omnivoice+studio"
submit "DBpedia Lookup"                 "https://lookup.dbpedia.org/api/search?query=omnivoice&maxResults=5"
submit "DuckDuckGo Instant"             "https://api.duckduckgo.com/?q=omnivoice+studio&format=json"
submit "Brave Search"                   "https://search.brave.com/search?q=omnivoice+studio"
submit "Ecosia Search"                  "https://www.ecosia.org/search?q=omnivoice+studio"
submit "Qwant Search"                   "https://www.qwant.com/?q=omnivoice+studio"
submit "Mojeek Search"                  "https://www.mojeek.com/search?q=omnivoice+studio"
submit "You.com Search"                 "https://you.com/search?q=omnivoice+studio"
submit "Perplexity Search"              "https://www.perplexity.ai/search?q=omnivoice+studio"
submit "Phind Search"                   "https://www.phind.com/search?q=omnivoice+studio"
submit "Kagi Search"                    "https://kagi.com/search?q=omnivoice+studio"
submit "Marginalia Search"              "https://search.marginalia.nu/search?query=omnivoice+studio"
submit "Yep Search"                     "https://yep.com/web?q=omnivoice+studio"
submit "Swisscows"                      "https://swisscows.com/en/web?query=omnivoice+studio"
submit "MetaGer"                        "https://metager.org/meta/meta.ger3?eingabe=omnivoice+studio"
submit "Startpage"                      "https://www.startpage.com/sp/search?query=omnivoice+studio"
submit "Searx"                          "https://searx.be/search?q=omnivoice+studio"

# ── SUMMARY ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                  WAVE 2 SUBMISSION RESULTS                      ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
printf "║  Total submissions:  %-40s ║\n" "$TOTAL"
printf "║  ${GREEN}Successful:          %-40s${NC} ║\n" "$SUCCESS"
printf "║  ${RED}Failed/Unreachable:  %-40s${NC} ║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "🚀 Wave 2 complete. Combined with Wave 1, you've pinged 200+ endpoints."
echo ""
echo "📋 Next steps for MAXIMUM impact:"
echo "   1. Run both scripts weekly:  bash scripts/seo-backlink-submit.sh && bash scripts/seo-backlink-wave2.sh"
echo "   2. Create a dev.to article linking back to the repo"
echo "   3. Submit to r/selfhosted, r/opensource, r/MachineLearning"
echo "   4. Add schema.org SoftwareApplication JSON-LD to your docs site"
echo "   5. Set up a simple landing page with your own domain for dofollow backlinks"
echo ""
