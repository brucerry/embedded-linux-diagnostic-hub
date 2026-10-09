// Fixed read-only discovery. Binary fields are hex framed; no user text selects commands or paths.
export const DISCOVERY_COMMAND = String.raw`
printf 'HUB-INVENTORY-1\n'
hex() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n'; }
issue() { printf 'E\t'; hex "$1"; printf '\n'; }
value() { if [ -r "$1" ]; then head -c 4096 "$1" 2>/dev/null | tr '\000' ' '; fi; }
field() { printf 'D\t%s\t' "$1"; hex "$2"; printf '\n'; }
dtroot=/sys/firmware/devicetree/base
[ -d "$dtroot" ] || dtroot=/proc/device-tree
dtcanon=$(readlink -f "$dtroot" 2>/dev/null)
node() { n=$(readlink -f "$1" 2>/dev/null); case "$n" in "$dtcanon"/*) printf '%s' "$n" | sed "s|^$dtcanon||";; esac; }
resource() {
    printf 'R'
    for val in "$@"; do printf '\t'; hex "$val"; done
    printf '\n'
}
field model "$(value "$dtroot/model")"
field serial "$(value "$dtroot/serial-number")"
field kernel "$(uname -r 2>/dev/null)"
field firmware "$(value /etc/os-release)"
field bootId "$(value /proc/sys/kernel/random/boot_id)"
if [ -d "$dtroot" ]; then
    find "$dtroot" -type f 2>&1 | {
        count=0
        while IFS= read -r p; do
            case "$p" in /*) ;; *) issue 'DT traversal incomplete.'; continue;; esac
            key=$(basename "$p"); parent=$(dirname "$p")
            case "$key:$parent" in
                model:*|compatible:*|status:*|reg:*|phandle:*|linux,phandle:*|\#*-cells:*|gpios:*|gpio-controller:*|gpio-line-names:*|label:*|function:*|color:*|pinctrl-*:*) ;;
                *:"$dtroot/aliases") ;;
                *) continue ;;
            esac
            count=$((count + 1)); [ "$count" -le 4096 ] || { issue 'DT property limit reached.'; break; }
            if [ ! -r "$p" ]; then issue "Cannot read DT property: $p"; continue; fi
            size=$(wc -c < "$p" 2>/dev/null)
            [ "$size" -le 8192 ] 2>/dev/null || { issue "DT property too large: $p"; continue; }
            rel=$(printf '%s' "$parent" | sed "s|^$dtroot||"); [ -n "$rel" ] || rel=/
            printf 'N\t'; hex "$rel"; printf '\t'; hex "$key"; printf '\t'
            od -An -v -tx1 "$p" 2>/dev/null | tr -d ' \n'; printf '\n'
        done
    }
fi
for tool in python3 i2cget timeout; do
    ok=0
    if command -v "$tool" >/dev/null 2>&1; then
        case "$tool" in
            python3) python3 -c 'import termios,fcntl,select,json; assert hasattr(termios,"TIOCEXCL")' >/dev/null 2>&1 && ok=1 ;;
            timeout) timeout -k 2 -s TERM 1 sh -c 'exit 0' >/dev/null 2>&1 && ok=1 ;;
            i2cget) ok=1 ;;
        esac
    fi
    printf 'C\t%s\t%s\n' "$tool" "$ok"
done
for p in /sys/class/leds/*; do
    [ -d "$p" ] || continue
    writable=0; [ -w "$p/brightness" ] && [ -w "$p/trigger" ] && writable=1
    [ -r "$p/brightness" ] && [ -r "$p/trigger" ] && [ -r "$p/max_brightness" ] || issue "Incomplete LED access: $p"
    name=$(basename "$p")
    resource led "$name" "$p" "$(node "$p/device/of_node")" '' "$name" '' 0 "$writable" "$(value "$p/max_brightness")" '' '' "$(value "$p/trigger")"
done
[ -r /proc/consoles ] || [ -r /sys/class/tty/console/active ] || issue 'Active console evidence is unavailable.'
consoles=" $(awk '{print $1}' /proc/consoles 2>/dev/null | tr '\n' ' ') $(value /sys/class/tty/console/active) "
for p in /sys/class/tty/*; do
    name=$(basename "$p"); [ -e "$p/device" ] && [ -c "/dev/$name" ] || continue
    console=0; case "$consoles" in *" $name "*) console=1;; esac
    writable=0; [ -r "/dev/$name" ] && [ -w "/dev/$name" ] && writable=1
    busy=unknown
    if command -v fuser >/dev/null 2>&1; then busy=no; fuser "/dev/$name" >/dev/null 2>&1 && busy=yes; fi
    resource uart "$name" "/dev/$name" "$(node "$p/device/of_node")" '' "$(readlink -f "$p/device/driver" 2>/dev/null)" '' "$console" "$writable" '' '' "$busy" ''
done
for p in /sys/bus/i2c/devices/*-*; do
    [ -d "$p" ] || continue
    name=$(basename "$p"); bus=$(printf '%s' "$name" | cut -d- -f1); address=$(printf '%s' "$name" | cut -d- -f2)
    case "$bus:$address" in *[!0-9a-f:]*|*:?????*) continue;; esac
    [ "$(printf '%s' "$address" | wc -c)" -eq 4 ] || continue
    decimal=$((0x$address)); busy=no; [ -e "$p/driver" ] && busy=yes
    writable=0; [ -r "/dev/i2c-$bus" ] && [ -w "/dev/i2c-$bus" ] && writable=1
    resource i2c "$(value "$p/name")" "$p" "$(node "$p/of_node")" "$(node "/sys/bus/i2c/devices/i2c-$bus/of_node")" "$(value "$p/modalias")" "$decimal" 0 "$writable" '' "$bus" "$busy" ''
done
for domain in gpio spi pcie lan hdmi watchdog; do
    case "$domain" in
        gpio) pattern='/sys/bus/gpio/devices/gpiochip*';;
        spi) pattern='/sys/bus/spi/devices/spi*.*';;
        pcie) pattern='/sys/bus/pci/devices/*';;
        lan) pattern='/sys/class/net/*';;
        hdmi) pattern='/sys/class/drm/card*-*';;
        watchdog) pattern='/sys/class/watchdog/watchdog*';;
    esac
    for p in $pattern; do
        [ -d "$p" ] || continue
        current=$domain
        if [ "$domain" = lan ] && { [ -d "$p/wireless" ] || [ -e "$p/phy80211" ]; }; then current=wlan; fi
        resource "$current" "$(basename "$p")" "$p" "$(node "$p/device/of_node")" '' "$(value "$p/modalias")" '' 0 0 '' '' '' ''
    done
done
printf 'HUB-INVENTORY-END\n'
`;
