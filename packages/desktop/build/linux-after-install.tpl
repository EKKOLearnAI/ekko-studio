#!/bin/bash

install_dir='/opt/${sanitizedProductName}'
compat_dir='/opt/${executable}'
desktop_file='/usr/share/applications/com.hermeswebui.studio.desktop'

if [ "$install_dir" != "$compat_dir" ]; then
    ln -sfn "$install_dir" "$compat_dir"
fi

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives.
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --remove '${executable}' "$install_dir/${executable}" 2>/dev/null || true
    update-alternatives --install '/usr/bin/${executable}' '${executable}' "$compat_dir/${executable}" 100 || ln -sf "$compat_dir/${executable}" '/usr/bin/${executable}'
else
    ln -sf "$compat_dir/${executable}" '/usr/bin/${executable}'
fi

if [ -f "$desktop_file" ]; then
    sed -i "s#Exec=\"$install_dir/${executable}\"#Exec=\"$compat_dir/${executable}\"#" "$desktop_file" || true
    sed -i "s#Exec=$install_dir/${executable}#Exec=$compat_dir/${executable}#" "$desktop_file" || true
fi

# Check if user namespaces are supported by the kernel and working with a quick test.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces.
    chmod 4755 "$install_dir/chrome-sandbox" || true
else
    chmod 0755 "$install_dir/chrome-sandbox" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
