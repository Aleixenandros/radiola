#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build and install helper for this GNOME Shell extension. It reads the
# extension id, name and schema from the project files, so the same script
# works for any extension laid out like this one.
#
#   ./build.sh                 interactive menu
#   ./build.sh install -e      build, install and enable
#   ./build.sh help            all commands
#
# Only standard GNOME tools are needed: gnome-extensions,
# glib-compile-schemas and msgfmt (plus xgettext/msgmerge for `pot`).

set -euo pipefail
shopt -s nullglob

cd "$(dirname "$(readlink -f "$0")")"

meta() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" metadata.json | head -1; }

UUID=$(meta uuid)
NAME=$(meta name)
DOMAIN=$(meta gettext-domain)
SCHEMA=$(find schemas -name '*.gschema.xml' 2>/dev/null | head -1)
EXTRA_DIRS=(lib icons)
BUILD_DIR=build
ZIP=$BUILD_DIR/$UUID.shell-extension.zip
INSTALL_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID
JS_FILES=(extension.js prefs.js lib/*.js)

# ── Output helpers ─────────────────────────────────────────────────

# Spanish messages when the locale is Spanish, English otherwise.
if [[ ${LC_ALL:-${LC_MESSAGES:-${LANG:-}}} == es* ]]; then ES=1; else ES=0; fi

# t "English" "Español"
t() { if ((ES)); then printf '%s' "$2"; else printf '%s' "$1"; fi; }

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
    BOLD=$'\e[1m' BLUE=$'\e[34m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
else
    BOLD='' BLUE='' GREEN='' YELLOW='' RED='' RESET=''
fi

step() { printf '%s==>%s %s\n' "$BLUE$BOLD" "$RESET" "$*"; }
ok()   { printf '%sOK%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ── Dependencies ───────────────────────────────────────────────────

# Package that provides a tool on each distribution family.
package_for() {
    local tool=$1 pm=$2
    case $tool:$pm in
        gnome-extensions:*)            echo gnome-shell ;;
        glib-compile-schemas:apt)      echo libglib2.0-bin ;;
        glib-compile-schemas:zypper)   echo glib2-tools ;;
        glib-compile-schemas:*)        echo glib2 ;;
        msgfmt:zypper | xgettext:zypper | msgmerge:zypper) echo gettext-tools ;;
        msgfmt:* | xgettext:* | msgmerge:*) echo gettext ;;
    esac
}

require() {
    local missing=() tool
    for tool in "$@"; do
        command -v "$tool" >/dev/null || missing+=("$tool")
    done
    ((${#missing[@]} == 0)) && return 0

    local pm='' install=''
    if command -v dnf >/dev/null; then pm=dnf install='sudo dnf install'
    elif command -v apt-get >/dev/null; then pm=apt install='sudo apt install'
    elif command -v pacman >/dev/null; then pm=pacman install='sudo pacman -S'
    elif command -v zypper >/dev/null; then pm=zypper install='sudo zypper install'
    fi

    warn "$(t 'Missing tools:' 'Faltan herramientas:') ${missing[*]}"
    if [[ -n $pm ]]; then
        local packages
        packages=$(for tool in "${missing[@]}"; do package_for "$tool" "$pm"; done | sort -u | tr '\n' ' ')
        printf '  %s\n\n    %s %s\n\n' "$(t 'Install them with:' 'Instálalas con:')" "$install" "$packages" >&2
    fi
    exit 1
}

# ── Info ───────────────────────────────────────────────────────────

shell_version() { gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1; }

supported_versions() {
    sed -n '/"shell-version"/,/]/p' metadata.json | grep -oE '"[0-9.]+"' | tr -d '"' | paste -sd ' '
}

version_name() { meta version-name; }

check_shell_version() {
    local current supported
    current=$(shell_version) || true
    supported=$(supported_versions)
    [[ -z $current ]] && return 0
    if [[ " $supported " != *" $current "* ]]; then
        warn "$(t "Your GNOME Shell is $current, but this extension supports: $supported" \
                  "Tu GNOME Shell es la $current, pero esta extensión es para: $supported")"
        warn "$(t 'It may not load.' 'Puede que no cargue.')"
    fi
}

is_installed() { [[ -f $INSTALL_DIR/metadata.json ]]; }

is_enabled() {
    gsettings get org.gnome.shell enabled-extensions 2>/dev/null | grep -q "'$UUID'"
}

# ── Commands ───────────────────────────────────────────────────────

cmd_check() {
    require glib-compile-schemas msgfmt
    step "$(t 'Checking the settings schema and translations' 'Comprobando el esquema de opciones y las traducciones')"
    [[ -z $SCHEMA ]] || glib-compile-schemas --strict --dry-run schemas
    local po
    for po in po/*.po; do
        msgfmt --check -o /dev/null "$po"
    done
    ok "$(t 'Everything is valid' 'Todo es válido')"
}

cmd_build() {
    require gnome-extensions glib-compile-schemas msgfmt
    cmd_check
    step "$(t "Building $NAME $(version_name)" "Compilando $NAME $(version_name)")"
    local args=(--force --out-dir="$BUILD_DIR" --podir=po) dir
    [[ -n $SCHEMA ]] && args+=(--schema="$SCHEMA")
    for dir in "${EXTRA_DIRS[@]}"; do
        [[ -d $dir ]] && args+=(--extra-source="$dir")
    done
    mkdir -p "$BUILD_DIR"
    gnome-extensions pack "${args[@]}" .
    ok "$(t 'Package ready:' 'Paquete listo:') $ZIP ($(du -h "$ZIP" | cut -f1))"
}

cmd_install() {
    local enable=0
    case ${1:-} in
        -e | --enable) enable=1 ;;
        '') ;;
        *) die "$(t "Unknown option: $1" "Opción desconocida: $1")" ;;
    esac

    check_shell_version
    cmd_build
    step "$(t 'Installing for the current user' 'Instalando para el usuario actual')"
    gnome-extensions install --force "$ZIP"
    ok "$(t 'Installed in' 'Instalada en') $INSTALL_DIR"

    if ((enable)); then
        cmd_enable
    elif ! is_enabled; then
        printf '  %s ./build.sh enable\n' "$(t 'To turn it on, run:' 'Para activarla, ejecuta:')"
    fi

    printf '\n%s%s%s\n' "$BOLD" "$(t 'Log out and back in to load the new version (needed on Wayland).' \
        'Cierra sesión y vuelve a entrar para cargar la nueva versión (necesario en Wayland).')" "$RESET"
}

cmd_uninstall() {
    require gnome-extensions
    is_installed || die "$(t 'The extension is not installed' 'La extensión no está instalada')"
    step "$(t 'Uninstalling' 'Desinstalando')"
    gnome-extensions uninstall "$UUID"
    ok "$(t 'Uninstalled' 'Desinstalada')"
}

cmd_enable() {
    require gnome-extensions
    if gnome-extensions enable "$UUID" 2>/dev/null; then
        ok "$(t 'Enabled' 'Activada')"
        return
    fi

    # The running GNOME Shell only knows the extensions that were installed
    # when the session started. Add it to the list of enabled extensions so
    # it starts with the next session.
    is_installed || die "$(t 'Install the extension first: ./build.sh install' 'Instala antes la extensión: ./build.sh install')"
    local list
    list=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ $list != *"'$UUID'"* ]]; then
        if [[ $list == *'[]' ]]; then
            list="['$UUID']"
        else
            list="${list%]}, '$UUID']"
        fi
        gsettings set org.gnome.shell enabled-extensions "$list"
    fi
    ok "$(t 'Enabled. It will start after you log out and back in.' \
            'Activada. Arrancará al cerrar sesión y volver a entrar.')"
}

cmd_disable() {
    require gnome-extensions
    gnome-extensions disable "$UUID"
    ok "$(t 'Disabled' 'Desactivada')"
}

cmd_prefs() {
    require gnome-extensions
    is_installed || die "$(t 'Install the extension first: ./build.sh install' 'Instala antes la extensión: ./build.sh install')"
    gnome-extensions prefs "$UUID"
}

# yesno <command...>: prints "yes"/"sí" or "no" depending on the result.
yesno() { if "$@"; then t yes sí; else t no no; fi; }

cmd_status() {
    printf '%s%s%s\n' "$BOLD" "$NAME $(version_name)" "$RESET"
    printf '  %-22s %s\n' "$(t 'GNOME Shell:' 'GNOME Shell:')" "$(shell_version || echo '?')"
    printf '  %-22s %s\n' "$(t 'Supported versions:' 'Versiones soportadas:')" "$(supported_versions)"
    printf '  %-22s %s\n' "$(t 'Installed:' 'Instalada:')" "$(yesno is_installed)"
    printf '  %-22s %s\n' "$(t 'Enabled:' 'Activada:')" "$(yesno is_enabled)"
    if is_installed && command -v gnome-extensions >/dev/null; then
        local state
        state=$(gnome-extensions info "$UUID" 2>/dev/null | grep -iE 'state|estado' | sed 's/^ */  /') || true
        [[ -n $state ]] && printf '%s\n' "$state"
        # The running shell keeps the old metadata until the next login.
        if [[ $state == *"OUT OF DATE"* && " $(supported_versions) " == *" $(shell_version) "* ]]; then
            printf '  %s\n' "$(t 'The new version loads after you log out and back in.' \
                'La nueva versión se carga al cerrar sesión y volver a entrar.')"
        fi
    fi
}

cmd_pot() {
    require xgettext msgmerge
    step "$(t 'Updating translation template' 'Actualizando la plantilla de traducciones')"
    xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
        --add-comments=Translators --package-name="$UUID" \
        --output="po/$DOMAIN.pot" "${JS_FILES[@]}"
    local po
    for po in po/*.po; do
        msgmerge --quiet --update --backup=none "$po" "po/$DOMAIN.pot"
    done
    ok "$(t 'Done. Translate the new strings in po/*.po' 'Hecho. Traduce las cadenas nuevas en po/*.po')"
}

cmd_clean() {
    rm -rf "$BUILD_DIR"
    ok "$(t 'Removed' 'Eliminado') $BUILD_DIR/"
}

cmd_help() {
    cat <<EOF
${BOLD}$NAME $(version_name)${RESET} - $(t 'build and install helper' 'compilar e instalar')

$(t 'Usage' 'Uso'): ./build.sh [$(t 'command' 'comando')]

$(t 'Commands' 'Comandos'):
  build              $(t 'Build the extension zip in build/' 'Compila el .zip de la extensión en build/')
  install [-e]       $(t 'Build and install for the current user (-e: also enable it)' 'Compila e instala para el usuario actual (-e: y la activa)')
  uninstall          $(t 'Remove the installed extension' 'Elimina la extensión instalada')
  enable | disable   $(t 'Turn the extension on or off' 'Activa o desactiva la extensión')
  prefs              $(t 'Open the preferences window' 'Abre la ventana de preferencias')
  status             $(t 'Show version, compatibility and install state' 'Muestra versión, compatibilidad y estado')
  check              $(t 'Validate the settings schema and translations' 'Valida el esquema de opciones y las traducciones')
  pot                $(t 'Update translation files after changing texts' 'Actualiza las traducciones tras cambiar textos')
  clean              $(t 'Remove the build/ folder' 'Borra la carpeta build/')
  help               $(t 'Show this help' 'Muestra esta ayuda')

$(t 'Without a command, an interactive menu is shown.' 'Sin comando, se muestra un menú interactivo.')
EOF
}

cmd_menu() {
    cmd_status
    echo
    local options=(
        "$(t 'Build, install and enable' 'Compilar, instalar y activar')"
        "$(t 'Build and install' 'Compilar e instalar')"
        "$(t 'Build only' 'Solo compilar')"
        "$(t 'Open preferences' 'Abrir preferencias')"
        "$(t 'Uninstall' 'Desinstalar')"
        "$(t 'Exit' 'Salir')"
    )
    local i
    for i in "${!options[@]}"; do
        printf '  %s%d)%s %s\n' "$BOLD" $((i + 1)) "$RESET" "${options[i]}"
    done
    printf '\n%s ' "$(t 'Choose an option [1]:' 'Elige una opción [1]:')"

    local choice
    read -r choice || choice=6
    echo
    case ${choice:-1} in
        1) cmd_install --enable ;;
        2) cmd_install ;;
        3) cmd_build ;;
        4) cmd_prefs ;;
        5) cmd_uninstall ;;
        6) ;;
        *) die "$(t 'Invalid option' 'Opción no válida')" ;;
    esac
}

# ── Main ───────────────────────────────────────────────────────────

command=${1:-}
[[ $# -gt 0 ]] && shift

case $command in
    build | pack)  cmd_build ;;
    install)       cmd_install "$@" ;;
    uninstall)     cmd_uninstall ;;
    enable)        cmd_enable ;;
    disable)       cmd_disable ;;
    prefs)         cmd_prefs ;;
    status)        cmd_status ;;
    check)         cmd_check ;;
    pot)           cmd_pot ;;
    clean)         cmd_clean ;;
    help | -h | --help) cmd_help ;;
    '')
        if [[ -t 0 ]]; then cmd_menu; else cmd_help; fi ;;
    *)
        cmd_help >&2
        die "$(t "Unknown command: $command" "Comando desconocido: $command")" ;;
esac
