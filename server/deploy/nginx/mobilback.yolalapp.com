# mobilback.yolalapp.com — MobilApp backend (FastAPI in Docker, 127.0.0.1:8012)
# Cloudflare (proxied) -> nginx -> uvicorn. TLS terminated here with Let's Encrypt (certbot --nginx adds the 443 block).

limit_req_zone $binary_remote_addr zone=mobilapp_auth:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=mobilapp_api:10m rate=60r/s;

server {
    server_name mobilback.yolalapp.com;

    include /etc/nginx/snippets/cloudflare-realip.conf;

    client_max_body_size 5M;
    server_tokens off;

    # health check without rate limiting or logging noise
    location = /health {
        proxy_pass http://127.0.0.1:8012;
        proxy_set_header Host $host;
        access_log off;
    }

    location /api/v1/auth/ {
        limit_req zone=mobilapp_auth burst=20 nodelay;
        proxy_pass http://127.0.0.1:8012;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / {
        limit_req zone=mobilapp_api burst=120 nodelay;
        proxy_pass http://127.0.0.1:8012;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;   # stellar submissions can take a while
        proxy_send_timeout 120s;
    }

    listen [::]:443 ssl; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/mobilback.yolalapp.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/mobilback.yolalapp.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}


server {
    if ($host = mobilback.yolalapp.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    listen [::]:80;
    server_name mobilback.yolalapp.com;
    return 404; # managed by Certbot


}