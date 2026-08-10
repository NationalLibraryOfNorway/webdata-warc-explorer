FROM nginxinc/nginx-unprivileged:alpine
COPY app /usr/share/nginx/html/warc-explorer
