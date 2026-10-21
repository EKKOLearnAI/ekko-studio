#!/bin/bash
# Disposable Ubuntu smoke test; not a substitute for TNAS App Center acceptance.
set -euo pipefail
deb="$(realpath "${1:?Usage: bash scripts/test-tos-install.sh package.deb}")"
container="$(docker run --detach --init ubuntu:22.04 sleep infinity)"
trap 'docker rm --force "$container" >/dev/null' EXIT
# Copy instead of bind-mounting so a remote Docker daemon also works.
docker cp "$deb" "$container:/package.deb"
docker exec -i "$container" bash -s <<'CONTAINER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
    libc6 libstdc++6 libgcc-s1 zlib1g systemd bash bzip2 ca-certificates git python3 curl procps

# This container has no systemd PID 1. Record service operations, then launch the
# actual packaged server under the service account with the unit's environment.
cat >/usr/local/bin/systemctl <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>/tmp/systemctl.log
# Reproduce the unloaded-unit failure from the TOS review on every stop.
if [ "$1" = stop ]; then exit 5; fi
STUB
chmod 0755 /usr/local/bin/systemctl
export PATH="/usr/local/bin:$PATH"
app=/usr/local/com.hermeswebui.studio
user=ekko-studio-tos
package=ekko-studio-tos
! id -u "$user" >/dev/null 2>&1
! getent group "$user" >/dev/null
! dpkg-query -W -f='${Status}\n' python3-venv python3.10-venv 2>/dev/null | grep -q 'install ok installed'
if python3 -m venv /tmp/host-venv > /tmp/host-venv.log 2>&1; then
    echo "Fixture must lack a working host venv/ensurepip" >&2
    exit 1
fi
dpkg -i /package.deb
test "$(dpkg-query -W -f='${Status}' "$package")" = "install ok installed"
uid="$(id -u "$user")"
gid="$(getent group "$user" | cut -d: -f3)"
test "$uid" != 0
test "$gid" != 0
test "$(getent passwd "$user" | cut -d: -f6)" = "$app/data/home"
test "$(getent passwd "$user" | cut -d: -f7)" = /usr/sbin/nologin
test "$(stat -c '%u:%g:%a' "$app/data/studio")" = "$uid:$gid:700"

mapfile -t service_env < <(sed -n 's/^Environment=//p' "$app/init.d/$package.service")
start_server() {
    (cd "$app/data" && exec runuser -u "$user" -- env "${service_env[@]}" \
        "$app/bin/ekko-studio") >/tmp/studio.log 2>&1 &
    for attempt in $(seq 1 60); do
        if curl --fail --silent http://127.0.0.1:8648/api/auth/status >/tmp/auth-status.json; then
            cat /tmp/auth-status.json
            printf '\n'
            return
        fi
        sleep 1
    done
    cat /tmp/studio.log
    return 1
}
stop_server() {
    # Signal the service account's processes only, inside this disposable container.
    pkill -TERM -u "$uid" || true
    wait || true
}
start_server
runuser -u "$user" -- sh -c 'printf retained > "$1/data/workspaces/install-smoke.txt"' sh "$app"
stop_server

# Reconfiguration and same-version reinstall exercise the upgrade path without
# inventing an application release version. Identity and existing files must stay.
"/var/lib/dpkg/info/$package.postinst" configure
dpkg -i /package.deb
test "$(id -u "$user")" = "$uid"
test "$(getent group "$user" | cut -d: -f3)" = "$gid"
test "$(cat "$app/data/workspaces/install-smoke.txt")" = retained
start_server
stop_server
dpkg --remove "$package"
test ! -e "$app/data"
test ! -e "$app/logs"
! id -u "$user" >/dev/null 2>&1
! getent group "$user" >/dev/null
dpkg -i /package.deb
dpkg --purge "$package"
test ! -e "$app/data"
test ! -e "$app/logs"
! id -u "$user" >/dev/null 2>&1
! getent group "$user" >/dev/null
test ! -L "/etc/systemd/system/$package.service"
grep -Fx "enable $package.service" /tmp/systemctl.log
grep -Fx "restart $package.service" /tmp/systemctl.log
grep -Fx "stop $package.service" /tmp/systemctl.log
grep -Fx "disable $package.service" /tmp/systemctl.log
echo "PASS: fresh install without host venv, non-root startup, reconfigure, upgrade retention and uninstall cleanup"
echo "LIMIT: service-manager calls were recorded; real TOS/systemd acceptance remains required"
CONTAINER
