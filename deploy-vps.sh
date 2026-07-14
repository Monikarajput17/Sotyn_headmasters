#!/bin/bash
# SEPL Business ERP - VPS Deployment Script
# Run this on your Hostinger VPS as root

echo "=========================================="
echo "  SEPL Business ERP - VPS Setup"
echo "=========================================="

# Update system
echo ">>> Updating system..."
apt update -y && apt upgrade -y

# Install Node.js 20
echo ">>> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install build tools
echo ">>> Installing build tools..."
apt install -y build-essential python3 git nginx

# Install PM2
echo ">>> Installing PM2..."
npm install -g pm2

# Clone repo
echo ">>> Cloning ERP code..."
cd /root
rm -rf /root/erp
git clone https://github.com/Monikarajput17/SEPL.git /root/erp
cd /root/erp

# Install dependencies
echo ">>> Installing dependencies..."
npm install

# Build frontend
echo ">>> Building frontend..."
cd client && npm install && npm run build && cd ..

# Set environment
echo ">>> Setting environment..."
cat > .env << 'ENV'
PORT=5000
JWT_SECRET=sepl-erp-secret-key-2026
NODE_ENV=production
ENV

# Start with PM2
echo ">>> Starting server with PM2..."
pm2 delete erp 2>/dev/null
pm2 start server/index.js --name erp
pm2 save
pm2 startup

# Setup Nginx with domain
echo ">>> Setting up Nginx for securederp.in..."
cat > /etc/nginx/sites-available/erp << 'NGINX'
server {
    listen 80;
    server_name securederp.in www.securederp.in;

    client_max_body_size 20M;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
systemctl enable nginx

# Install free HTTPS via Let's Encrypt
echo ">>> Installing HTTPS (Let's Encrypt)..."
apt install -y certbot python3-certbot-nginx
certbot --nginx -d securederp.in -d www.securederp.in \
  --non-interactive --agree-tos -m admin@securederp.in --redirect

# Auto-renewal is set up by certbot package via systemd timer

echo ""
echo "=========================================="
echo "  DEPLOYMENT COMPLETE!"
echo "  Open: https://securederp.in"
echo "  Login: admin@erp.com / admin123"
echo "=========================================="
