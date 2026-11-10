# Bot desktop: one container per user, four X displays, no host mounts.
#
# What Orgo used to provide, in a box the host can throw away:
#   Xvfb :99        primary display, also :1 :2 :3 for extra bot screens
#   x11vnc + websockify  one viewer per display, bound to loopback inside the box
#   chromium        the bot's browser, per-bot profile dir
#   imagemagick     screenshot conversion (xwd -> png)
#
# Deliberately NOT installed: sshd, the docker client, any credential. The only
# way in is docker exec, which is the host's own privilege boundary.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LIBGL_ALWAYS_SOFTWARE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc x11-utils xdotool x11-xserver-utils \
      imagemagick \
      chromium \
      xfwm4 xfdesktop4 dbus-x11 \
      python3 python3-websockify \
      fonts-dejavu-core fonts-noto-color-emoji \
      procps curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# A bot runs as its own unprivileged user, not root, so a stray rm stops at the box.
RUN useradd -m -s /bin/bash -u 1000 bot \
 && mkdir -p /home/bot/grokbot/profiles /home/bot/grokbot/files \
 && chown -R bot:bot /home/bot/grokbot

COPY entrypoint.sh /usr/local/bin/grokbot-entrypoint
COPY shot.sh /usr/local/bin/grokbot-shot
# chmod here rather than `COPY --chmod`, which needs BuildKit; this daemon has none.
RUN chmod 0755 /usr/local/bin/grokbot-entrypoint /usr/local/bin/grokbot-shot

USER bot
WORKDIR /home/bot

# websockify ports: 6080 + display index (99 -> 6080, 1..3 -> 6081..6083)
EXPOSE 6080 6081 6082 6083

# tini reaps the X servers instead of leaving zombies when the box is stopped.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/grokbot-entrypoint"]
