# Thomas task runner. `just` alone lists recipes.

# The desktop app: the same UI in an Electron window with native file dialogs and PDF export.
run-electron:
    npm run app

# All tests.
test:
    npm test

# The launcher points back at this checkout and at its build in out/ (run it again after moving
# the checkout). Log out/in or run `update-desktop-database ~/.local/share/applications` if it
# doesn't appear.

# Builds the app and installs a GNOME/XDG launcher + icon into ~/.local/share.
install-desktop:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{ justfile_directory() }}"
    npm run app:build
    install -Dm644 "$root/build/icon.png" ~/.local/share/icons/hicolor/512x512/apps/thomas.png
    install -Dm644 "$root/build/icon.svg" ~/.local/share/icons/hicolor/scalable/apps/thomas.svg
    mkdir -p ~/.local/share/applications
    cat > ~/.local/share/applications/thomas.desktop <<DESKTOP
    [Desktop Entry]
    Type=Application
    Name=Thomas
    Comment=Music notation editor
    Path=$root
    Exec=$root/node_modules/.bin/electron $root
    Icon=$root/build/icon.png
    Terminal=false
    Categories=AudioVideo;Audio;Midi;
    StartupWMClass=thomas
    DESKTOP
    sed -i 's/^    //' ~/.local/share/applications/thomas.desktop
    update-desktop-database ~/.local/share/applications 2>/dev/null || true
    gtk-update-icon-cache -q ~/.local/share/icons/hicolor 2>/dev/null || true
