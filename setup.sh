#!/usr/bin/env bash
# Installs or updates Emplio from this folder: writes .env the first time, then fetches everything and starts it.
#   ./setup.sh           use the ready-made images, or build them here if they can't be fetched
#   ./setup.sh --build   always build from this source
set -euo pipefail
cd "$(dirname "$0")"

export SETUP_LOG="$PWD/setup.log"
(umask 077; : >"$SETUP_LOG")

command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || { echo "Install Docker with Compose first: https://docs.docker.com/get-docker/" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Can't reach Docker. Start it, or give yourself access with: sudo usermod -aG docker \$USER, then log in again." >&2; exit 1; }

# The screens come from gum, one small program fetched once and checked against these sums. With no terminal, or if
# it can't be fetched, everything still works as plain text.
GUM_VERSION=2.0.2
gum_sum() {
  case "$1" in
    Linux_x86_64) echo d842e06d93dbed90af48cb8dd10698db6f22e331fc40346bb37bbc753109edc2 ;;
    Linux_arm64) echo 8ebf8b54ec1e8c81f2bb58b59ff9b70998186a4d11375f0cf357b80e0ccfa1d5 ;;
    Darwin_x86_64) echo 5374966c7c7199ea879fcaa525ddc6d447a098d3d35496e430a9a1ef38d30485 ;;
    Darwin_arm64) echo 4777a69b1170b8db23c95d5889fb32186cfda1a3ac950d339aa17e3513633890 ;;
    *) return 1 ;;
  esac
}
gum=""
get_gum() {
  [ -t 0 ] && [ -t 1 ] || return 0
  local bin=".setup/gum-$GUM_VERSION" arch name want got
  arch="$(uname -m)"
  [ "$arch" = aarch64 ] && arch=arm64
  name="$(uname -s)_$arch"
  if [ ! -x "$bin" ]; then
    want="$(gum_sum "$name")" || return 0
    mkdir -p .setup
    curl -fsSL -m 60 -o .setup/gum.tar.gz "https://github.com/charmbracelet/gum/releases/download/v$GUM_VERSION/gum_${GUM_VERSION}_$name.tar.gz" || return 0
    got="$( (sha256sum .setup/gum.tar.gz 2>/dev/null || shasum -a 256 .setup/gum.tar.gz) | cut -d' ' -f1)"
    [ "$got" = "$want" ] || return 0
    tar -xzf .setup/gum.tar.gz --strip-components=1 -C .setup "gum_${GUM_VERSION}_$name/gum" || return 0
    mv .setup/gum "$bin"
    rm -f .setup/gum.tar.gz
  fi
  gum="$PWD/$bin"
}

green="#5FA37E"
ok() { if [ -n "$gum" ]; then "$gum" style --foreground "$green" --margin "0 2" "✓ $1"; else echo "✓ $1"; fi; }
bad() { if [ -n "$gum" ]; then "$gum" style --foreground "#D9705F" --margin "0 2" "✗ $1" >&2; else echo "✗ $1" >&2; fi; }
note() { if [ -n "$gum" ]; then "$gum" style --faint --margin "0 2" "$1"; else echo "$1"; fi; }

# the wordmark: a green e with its closed eye, then the rest. Too narrow a terminal would break it up.
logo() {
  [ -n "$gum" ] || return 0
  local cols
  cols="$(stty size 2>/dev/null | cut -d' ' -f2)"
  if [ "${cols:-0}" -lt 56 ]; then
    "$gum" style --foreground "$green" --bold --margin "1 2 0 2" "emplio"
    return
  fi
  local e='

 ▄█████▄
██▀▄▄▄▀██
██▀▀▀▀▀▀▀
 ▀█▄▄▄▄▀▀
         '
  local rest='                         ██  ██
                         ██
  ██▄████▄███▄ ██▄█████▄ ██  ██  ▄█████▄
  ██   ██   ██ ██     ██ ██  ██ ██▀   ▀██
  ██   ██   ██ ██     ██ ██  ██ ██▄   ▄██
  ██   ██   ██ ██▀█████▀ ▀██ ██  ▀█████▀
               ██                        '
  "$gum" style --margin "1 2 0 2" "$("$gum" join --horizontal "$("$gum" style --foreground "$green" "$e")" "$rest")"
}

# ask <question> <example> [--password]: prints the answer
ask() {
  local answer
  if [ -n "$gum" ]; then
    # a set width: gum crashes working it out on a terminal that reports no size
    "$gum" input --width 70 --header "$1" --placeholder "$2" --prompt "› " --prompt.foreground "$green" --header.foreground 252 --cursor.foreground "$green" ${3:+"$3"}
  elif [ -n "${3:-}" ]; then
    read -r -s -p "$1 " answer
    echo >&2
    printf %s "$answer"
  else
    read -r -p "$1 ($2) " answer
    printf %s "$answer"
  fi
}

# step <doing this> <done> command...: hides the command's output in setup.log behind a spinner
step() {
  local doing="$1" finished="$2"
  shift 2
  if [ -n "$gum" ]; then
    "$gum" spin --spinner dot --spinner.foreground "$green" --title " $doing" -- bash -c '"$@" >>"$SETUP_LOG" 2>&1' _ "$@" || return 1
  else
    echo "$doing"
    "$@" || return 1
  fi
  ok "$finished"
}

die() {
  bad "$1"
  if [ -n "$gum" ]; then tail -n 15 "$SETUP_LOG" >&2; note "Everything it printed is in $SETUP_LOG"; fi
  exit 1
}

value() { sed -n "s/^$1=//p" .env; }
fill() { # name value: portable in-place edit
  awk -v k="$1" -v v="$2" 'index($0, k"=") == 1 { print k"="v; next } { print }' .env > .env.tmp && mv .env.tmp .env
}

# only a key the AI service itself turns down counts as wrong: no network here isn't the key's fault
key_refused() {
  [ "$(printf 'Authorization: Bearer %s\n' "$1" | curl -s -m 10 -o /dev/null -w '%{http_code}' -H @- https://openrouter.ai/api/v1/key || true)" = 401 ]
}

# a free web address that needs no sign-up: sslip.io answers for any name containing an IP address
free_address() {
  local ip
  ip="$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  echo "${ip//./-}.sslip.io"
}

get_gum || true

first=""
if [ ! -f .env ]; then
  first=1
  if [ -n "$gum" ]; then
    logo
    note "Three quick questions, then it sets itself up."
    echo
  fi

  # asked only with someone at the keyboard; a test passes these in instead
  key="${OPENROUTER_API_KEY:-}" email="${EMPLIO_EMAIL:-}" domain="${EMPLIO_DOMAIN:-}"
  if [ -t 0 ]; then
    while [ -z "$key" ]; do
      key="$(ask "Your OpenRouter key, for the AI. Get one at https://openrouter.ai/keys" "sk-or-..." --password)"
      if [ -n "$key" ] && key_refused "$key"; then
        bad "OpenRouter didn't accept that key. Try again."
        key=""
      fi
    done
    ok "AI key added"

    until [[ "$email" == ?*@?*.?* ]]; do
      email="$(ask "Your email, for your owner account" "you@company.com")"
    done
    ok "Owner: $email"

    if [ -z "$domain" ]; then
      if [ -n "$gum" ]; then
        here="On this computer, just for me" server="On a server with its own web address"
        # logged in from elsewhere: most likely a server, so that's what Enter picks
        if [ -n "${SSH_CONNECTION:-}" ]; then picked="$server"; else picked="$here"; fi
        where="$("$gum" choose --header "Where is this running?" --header.foreground 252 --cursor "› " --cursor.foreground "$green" --selected "$picked" "$here" "$server")"
        case "$where" in *server*) want_domain=1 ;; *) want_domain="" ;; esac
      else
        want_domain=1
      fi
      if [ -n "$want_domain" ]; then
        # the plain prompt has no menu before it, so there an empty answer still means "just this computer"
        free="" question="Web address (leave empty if it's just this computer)"
        if [ -n "$gum" ]; then
          free="$(free_address || true)"
          question="Your web address"
          [ -z "$free" ] || question="Your web address, or leave empty for a free one: $free"
          note "Using your own address? Point it at this server first. Either way, open ports 80 and 443."
        fi
        while :; do
          domain="$(ask "$question" "emplio.example.com")"
          domain="${domain#http://}" domain="${domain#https://}" domain="${domain%/}"
          if [ -z "$domain" ]; then
            [ -n "$gum" ] || break
            if [ -n "$free" ]; then
              domain="$free"
              note "This free address stops working if this server's IP address changes."
              break
            fi
            bad "Couldn't find this server's IP address, so please type a web address."
          elif [[ "$domain" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
            break
          else
            bad "That doesn't look like a web address."
          fi
        done
      fi
    fi
    if [ -n "$domain" ]; then ok "Address: https://$domain"; else ok "Running on this computer"; fi
    echo
  fi
  domain="${domain#http://}" domain="${domain#https://}" domain="${domain%/}"

  # it holds secrets: only you can read it, from the first moment
  umask 077
  cp .env.example .env
  fill ENCRYPTION_KEY "$(openssl rand -base64 32)"
  fill RUNNER_TOKEN "$(openssl rand -hex 32)"
  fill WHATSAPP_TOKEN "$(openssl rand -hex 32)"
  fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  fill SETUP_TOKEN "$(openssl rand -hex 32)"
  fill SETUP_EMAIL "$email"
  fill OPENROUTER_API_KEY "$key"
  if [ -n "$domain" ]; then
    fill EMPLIO_DOMAIN "$domain"
    fill COMPOSE_PROFILES https
    fill FRONTEND_URL "https://$domain"
    fill PUBLIC_API_URL "https://$domain/api"
    fill WEBHOOK_URL "https://$domain/api"
  fi
  umask 022
else
  ok "Keeping your settings"
fi

build() { step "Building Emplio. This takes about 8 minutes on a small server." "Built and started" docker compose up -d --build || die "The build failed."; }
if [ "${1:-}" = --build ] || [ -n "${EMPLIO_BUILD:-}" ]; then
  build
elif step "Downloading Emplio" "Downloaded" docker compose pull; then
  step "Starting Emplio" "Started" docker compose up -d --no-build || die "Emplio couldn't start."
else
  note "There's no ready-made version to download, so it will be built here."
  build
fi

wait_up() {
  for _ in $(seq 1 90); do
    curl -fsS -o /dev/null http://127.0.0.1:4000/health 2>/dev/null && curl -fsS -o /dev/null http://127.0.0.1:3000/login 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
wait_secure() {
  for _ in $(seq 1 45); do
    curl -fsS -m 5 -o /dev/null "https://$1/login" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
export -f wait_up wait_secure

step "Waiting for Emplio to wake up" "Emplio is running" wait_up || die "Emplio didn't start. See what happened with: docker compose logs app"

site="$(value FRONTEND_URL)"
address="$(value EMPLIO_DOMAIN)"
if [ -n "$address" ]; then
  step "Getting your secure address" "$site is secure and working" wait_secure "$address" ||
    bad "Emplio is running, but $site can't be reached yet. Point that address at this server and open ports 80 and 443; it will work by itself within a few minutes."
fi

if [ -z "$first" ]; then
  ok "Emplio is up to date, at $site"
  exit 0
fi

if [ -n "$(value SETUP_EMAIL)" ]; then
  link="$(value PUBLIC_API_URL)/auth/setup?t=$(value SETUP_TOKEN)"
  if [ -n "$gum" ]; then
    "$gum" style --foreground "$green" --border rounded --border-foreground "$green" --padding "0 2" --margin "1 2 0 2" --bold "Emplio is ready"
    note "Open this link to start. It signs you in as the owner and works only once."
    echo
  else
    echo
    echo "Emplio is ready. Open this link to start; it signs you in as the owner and works only once:"
    echo
  fi
  # plain and on its own line, so it can be copied whole
  echo "  $link"
  echo
  # only on this computer: a server has no browser to open
  if [ -z "$address" ] && [ -t 0 ]; then
    if command -v open >/dev/null; then open "$link"; elif command -v xdg-open >/dev/null; then xdg-open "$link" >/dev/null 2>&1 || true; fi
  fi
else
  ok "Emplio is running at $site. The first person to sign up becomes the owner."
fi
note "Add people from the team page. Until you set up email (see .env), their sign-in codes are written here:"
note "  cd $PWD && docker compose logs app | grep \"sign-in code\""
note "To update later, run this setup again."
