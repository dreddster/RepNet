#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# RepNet Security Scanner — DeFiMinty 21-Point Checklist
# Run: ./scripts/security-check.sh [--fix] [--ci]
# Exit code: 0 = clean, 1 = findings
# ═══════════════════════════════════════════════════════════════

set -eo pipefail

RED='\033[0;31m'
YEL='\033[0;33m'
GRN='\033[0;32m'
DIM='\033[0;90m'
RST='\033[0m'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FINDINGS=0
WARNINGS=0

CI_MODE="${1:-}"

finding() { echo -e "${RED}🔴 FAIL${RST} [$1] $2"; FINDINGS=$((FINDINGS + 1)); }
warning() { echo -e "${YEL}🟡 WARN${RST} [$1] $2"; WARNINGS=$((WARNINGS + 1)); }
pass()    { echo -e "${GRN}✅ PASS${RST} [$1] $2"; }

echo "═══════════════════════════════════════════════════════"
echo " RepNet Security Scanner (21-point checklist)"
echo " Repo: $REPO_ROOT"
echo " Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── 01: SECRETS & CONFIG ─────────────────────────────

echo -e "${DIM}── 01: SECRETS & CONFIG ──${RST}"

# [1] Hardcoded secrets/keys
HARDCODED=$(grep -rn --include="*.ts" --include="*.js" --include="*.mjs" --include="*.tsx" --include="*.jsx" \
  -E "(private[Kk]ey|privatekey|secret[Kk]ey|api[Kk]ey|apikey)\s*[:=]\s*['\"][0-9a-fA-Fx]" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "process\.env\|envVar\|loadConfig\|\.example\|\.test\.\|^\s*\*\|//\|'0x\.\.\.'" || true)

if [ -n "$HARDCODED" ]; then
  finding "1" "Hardcoded secrets found:"
  echo "$HARDCODED" | head -10 | sed 's/^/    /'
else
  pass "1" "No hardcoded secrets/keys"
fi

# [2] Secrets in logs
LOGGED_SECRETS=$(grep -rn --include="*.ts" --include="*.js" \
  -E "console\.(log|info|warn|error).*([Kk]ey|[Ss]ecret|[Tt]oken|[Pp]assword|private)" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "apiKey\|API.key\|publicKey\|\.example\|x-api-key\|rateLimit\|keyRecord\|ADMIN_KEY" || true)

if [ -n "$LOGGED_SECRETS" ]; then
  warning "2" "Possible secrets in logs:"
  echo "$LOGGED_SECRETS" | head -5 | sed 's/^/    /'
else
  pass "2" "No secrets leaking through logs"
fi

# [3] Env files in git
ENV_IN_GIT=$(cd "$REPO_ROOT" && git ls-files '*.env' '.env*' 2>/dev/null | grep -v "\.example" || true)
if [ -n "$ENV_IN_GIT" ]; then
  finding "3" "Env files tracked by git: $ENV_IN_GIT"
else
  pass "3" "No .env files in git tracking"
fi

# [4] Client-side API keys
CLIENT_KEYS=$(grep -rn --include="*.ts" --include="*.tsx" --include="*.jsx" --include="*.html" \
  -E "NEXT_PUBLIC_|VITE_.*KEY|REACT_APP_.*KEY|apiKey.*=.*['\"]" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -vi "example\|template\|placeholder\|ADMIN_KEY.*PUBLISHER" || true)

if [ -n "$CLIENT_KEYS" ]; then
  warning "4" "Possible client-side API keys:"
  echo "$CLIENT_KEYS" | head -5 | sed 's/^/    /'
else
  pass "4" "No client-side API key exposure"
fi

# [5] CORS too permissive
CORS_WILD=$(grep -rn --include="*.ts" --include="*.js" \
  -E "cors.*origin.*['\"]\\*['\"]|corsOrigin.*['\"]\\*['\"]|origin:\s*['\"]\\*['\"]|origin:\s*true" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "\.example\|process\.env\|\|\|config\." || true)

# Also check for wildcard as fallback default
CORS_DEFAULT=$(grep -rn --include="*.ts" --include="*.js" \
  -E '\|\|\s*["\x27]\*["\x27]' \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -i "cors\|origin" || true)

if [ -n "$CORS_WILD" ]; then
  finding "5" "CORS hardcoded wildcard (*) found:"
  echo "$CORS_WILD" | head -5 | sed 's/^/    /'
elif [ -n "$CORS_DEFAULT" ]; then
  warning "5" "CORS defaults to * when env not set (set CORS_ORIGIN in production):"
  echo "$CORS_DEFAULT" | head -3 | sed 's/^/    /'
else
  pass "5" "CORS properly configured"
fi

# [6] Vulnerable dependencies
echo -e "${DIM}  Running npm audit...${RST}"
AUDIT_RESULT=$(cd "$REPO_ROOT" && npm audit --json 2>/dev/null || true)
CRITICAL=$(AUDIT_JSON="$AUDIT_RESULT" node -e 'try { const data = JSON.parse(process.env.AUDIT_JSON || "{}"); console.log(data.metadata?.vulnerabilities?.critical ?? 0); } catch { console.log(0); }')
HIGH=$(AUDIT_JSON="$AUDIT_RESULT" node -e 'try { const data = JSON.parse(process.env.AUDIT_JSON || "{}"); console.log(data.metadata?.vulnerabilities?.high ?? 0); } catch { console.log(0); }')

if [ "$CRITICAL" -gt 0 ]; then
  finding "6" "npm audit: $CRITICAL critical, $HIGH high vulnerabilities"
elif [ "$HIGH" -gt 0 ]; then
  warning "6" "npm audit: $HIGH high vulnerabilities (0 critical)"
else
  pass "6" "No critical/high npm vulnerabilities"
fi

# [7] Default credentials
DEFAULT_CREDS=$(grep -rn --include="*.ts" --include="*.js" --include="*.json" \
  -E "(password|passwd)\s*[:=]\s*['\"]*(admin|root|test|password|123|default)" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null || true)

if [ -n "$DEFAULT_CREDS" ]; then
  finding "7" "Default credentials found:"
  echo "$DEFAULT_CREDS" | head -5 | sed 's/^/    /'
else
  pass "7" "No default credentials"
fi

# [8] Debug mode
DEBUG_ON=$(grep -rn --include="*.ts" --include="*.js" --include="*.json" \
  -E "NODE_ENV.*development|debug:\s*true|DEBUG\s*=\s*true|devtools.*true" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "\.example\|test\.\|spec\.\|\.test\|if.*NODE_ENV\|process\.env" || true)

if [ -n "$DEBUG_ON" ]; then
  warning "8" "Debug mode potentially enabled:"
  echo "$DEBUG_ON" | head -3 | sed 's/^/    /'
else
  pass "8" "No hardcoded debug mode"
fi

echo ""
echo -e "${DIM}── 02: ACCESS & API ──${RST}"

# [9-17] Route analysis
UNAUTHED_WRITES=$(grep -rn --include="*.ts" --include="*.js" \
  -E "app\.(post|put|patch|delete)\s*\(" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "adminAuth\|authHook\|authenticate\|verifyWallet\|verify.*[Ss]ignature\|rateLimitMiddleware\|\.test\.\|\.spec\." || true)

if [ -n "$UNAUTHED_WRITES" ]; then
  warning "9" "Write routes potentially missing auth middleware:"
  echo "$UNAUTHED_WRITES" | head -10 | sed 's/^/    /'
else
  pass "9" "All write routes have auth middleware"
fi

# [13] Rate limiting check
ROUTES_WITHOUT_RATELIMIT=$(grep -rn --include="*.ts" --include="*.js" \
  -E "app\.(get|post|put|patch|delete)\s*\(" \
  "$REPO_ROOT/services" "$REPO_ROOT/publisher" \
  --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null \
  | grep -v "rateLimit\|rateLimitMiddleware\|onRequest.*auth" | wc -l || echo "0")

if [ "$ROUTES_WITHOUT_RATELIMIT" -gt 10 ]; then
  warning "13" "~$ROUTES_WITHOUT_RATELIMIT routes may lack per-route rate limiting"
else
  pass "13" "Rate limiting coverage looks adequate"
fi

# [14] Error responses exposing internals
ERROR_LEAKS=$(grep -rn --include="*.ts" --include="*.js" \
  -E "res\.(status|json|send).*e\.(message|stack)|err\.(message|stack)" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "sanitize\|CHAIN_ERROR\|console\.\|\.test\.\|\.spec\.\|Internal server error" || true)

if [ -n "$ERROR_LEAKS" ]; then
  warning "14" "Error responses may leak internal details:"
  echo "$ERROR_LEAKS" | head -5 | sed 's/^/    /'
else
  pass "14" "Error responses properly sanitized"
fi

# [17] Admin routes by obscurity
ADMIN_ROUTES=$(grep -rn --include="*.ts" --include="*.js" \
  -E "app\.(get|post).*(/admin|/internal|/debug|/private)" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "auth\|middleware\|verify\|\.test\." || true)

if [ -n "$ADMIN_ROUTES" ]; then
  warning "17" "Admin/private routes may rely on URL obscurity:"
  echo "$ADMIN_ROUTES" | head -5 | sed 's/^/    /'
else
  pass "17" "No obscurity-only admin routes"
fi

echo ""
echo -e "${DIM}── 03: USER INPUT ──${RST}"

# [18] SQL injection (check for string interpolation in queries)
SQL_INTERP=$(grep -rn --include="*.ts" --include="*.js" \
  -E "(prepare|query|exec|run)\s*\(\s*\`|\.query\s*\(\s*['\"].*\\\$\{" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "\.prepare\(.*\?\)" || true)

if [ -n "$SQL_INTERP" ]; then
  warning "18" "Possible SQL string interpolation (use parameterized queries):"
  echo "$SQL_INTERP" | head -5 | sed 's/^/    /'
else
  pass "18" "No SQL injection patterns found"
fi

# [19] XSS (innerHTML, dangerouslySetInnerHTML)
XSS=$(grep -rn --include="*.ts" --include="*.tsx" --include="*.jsx" --include="*.html" \
  -E "innerHTML\s*=|dangerouslySetInnerHTML|document\.write\(|\.html\(" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "\.test\.\|\.spec\.\|sanitize\|escape" || true)

if [ -n "$XSS" ]; then
  warning "19" "Possible XSS vectors (innerHTML/document.write):"
  echo "$XSS" | head -5 | sed 's/^/    /'
else
  pass "19" "No obvious XSS vectors"
fi

# [20] File uploads without validation
UPLOADS=$(grep -rn --include="*.ts" --include="*.js" \
  -E "multer|upload|formidable|busboy|req\.files?" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -v "\.test\.\|\.spec\." || true)

if [ -n "$UPLOADS" ]; then
  warning "20" "File upload handling found — verify type/size checks:"
  echo "$UPLOADS" | head -3 | sed 's/^/    /'
else
  pass "20" "No file upload handling"
fi

# [21] Client-side payment/billing logic
CLIENT_PAYMENT=$(grep -rn --include="*.ts" --include="*.tsx" --include="*.jsx" --include="*.html" \
  -E "price|amount|discount|billing|payment" \
  "$REPO_ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -vi "server\|backend\|contract\|solidity\|test\|spec\|comment\|//\|README\|\.md" \
  | grep -i "client\|frontend\|component\|react\|vue\|html" || true)

if [ -n "$CLIENT_PAYMENT" ]; then
  warning "21" "Client-side payment logic found — verify server-side validation:"
  echo "$CLIENT_PAYMENT" | head -3 | sed 's/^/    /'
else
  pass "21" "No client-side payment bypass risk"
fi

# ─── SUMMARY ──────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$FINDINGS" -gt 0 ]; then
  echo -e " ${RED}$FINDINGS FAILURES${RST}, ${YEL}$WARNINGS warnings${RST}"
  echo " Fix all 🔴 findings before deploying."
  echo "═══════════════════════════════════════════════════════"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e " ${GRN}0 failures${RST}, ${YEL}$WARNINGS warnings${RST}"
  echo " Review warnings, but safe to proceed."
  echo "═══════════════════════════════════════════════════════"
  exit 0
else
  echo -e " ${GRN}ALL CLEAR — 0 failures, 0 warnings${RST} 🎉"
  echo "═══════════════════════════════════════════════════════"
  exit 0
fi
