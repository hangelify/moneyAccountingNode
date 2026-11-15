# Deployment Guide: Linux Server with GitHub Actions CI/CD

## Overview

This document provides a comprehensive guide for deploying both React frontend and NestJS backend to a dedicated Linux server with automated CI/CD using GitHub Actions.

---

## Part 1: Server Preparation

### 1.1 Server Requirements

- **OS**: Ubuntu 20.04+ or Debian 11+ (recommended)
- **RAM**: Minimum 2GB (4GB+ recommended)
- **CPU**: 2+ cores
- **Storage**: 20GB+ free space
- **Network**: Public IP address, ports 80/443 open

### 1.2 Initial Server Setup

#### Connect to Server

```bash
ssh root@your-server-ip
# or
ssh user@your-server-ip
```

#### Update System

```bash
sudo apt update && sudo apt upgrade -y
```

#### Install Essential Tools

```bash
# Node.js (using NodeSource repository)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version

# Install build tools
sudo apt install -y build-essential git curl

# Install PostgreSQL (if not using external DB)
sudo apt install -y postgresql postgresql-contrib

# Install Nginx
sudo apt install -y nginx

# Install PM2 for process management
sudo npm install -g pm2

# Install Certbot for SSL
sudo apt install -y certbot python3-certbot-nginx
```

#### Create Application User

```bash
# Create dedicated user for application
sudo adduser --disabled-password --gecos "" appuser
sudo usermod -aG sudo appuser

# Switch to app user
su - appuser
```

#### Set Up SSH Keys for Deployment

```bash
# On your local machine, generate SSH key if you don't have one
ssh-keygen -t ed25519 -C "deployment-key"

# Copy public key to server
ssh-copy-id appuser@your-server-ip

# On server, create .ssh directory if needed
mkdir -p ~/.ssh
chmod 700 ~/.ssh
```

---

## Part 2: Backend Deployment Setup

### 2.1 Backend Directory Structure

```bash
# On server
sudo mkdir -p /var/www/accounting-backend
sudo chown appuser:appuser /var/www/accounting-backend
cd /var/www/accounting-backend
```

### 2.2 Backend Environment Configuration

Create `.env` file on server:

```bash
nano /var/www/accounting-backend/.env
```

**.env (Production)**
```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=accounting_user
DB_PASSWORD=your-secure-password
DB_NAME=accounting

# JWT
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=your-super-secret-refresh-key-min-32-chars
JWT_REFRESH_EXPIRES_IN=7d

# CORS
FRONTEND_URL=https://yourdomain.com

# Server
PORT=3000
NODE_ENV=production

# Logging
LOG_LEVEL=info
```

**Secure the .env file:**
```bash
chmod 600 /var/www/accounting-backend/.env
```

### 2.3 Database Setup

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE accounting;
CREATE USER accounting_user WITH ENCRYPTED PASSWORD 'your-secure-password';
GRANT ALL PRIVILEGES ON DATABASE accounting TO accounting_user;
\q
```

### 2.4 PM2 Configuration

Create PM2 ecosystem file:

**ecosystem.config.js** (in backend repo)
```javascript
module.exports = {
  apps: [
    {
      name: 'accounting-backend',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '500M',
    },
  ],
};
```

### 2.5 Nginx Configuration for Backend

Create Nginx configuration:

```bash
sudo nano /etc/nginx/sites-available/accounting-backend
```

**/etc/nginx/sites-available/accounting-backend**
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;
    
    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logging
    access_log /var/log/nginx/accounting-backend-access.log;
    error_log /var/log/nginx/accounting-backend-error.log;

    # Proxy to NestJS
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Server-sent events of photo batches: no buffering, a long-lived
    # connection (the app sends a `ping` event every 25 s and ends the
    # stream when the access token expires).
    location ~ /bills/events$ {
        proxy_pass http://localhost:3000;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Receipt photo uploads. nginx refuses bodies over 1 MB by default
    # (413 before the app sees them). parse-photos takes up to 20 files of
    # 10 MB plus multipart overhead; parse-photo one file of 10 MB.
    location ~ /bills/parse-photos$ {
        client_max_body_size 210m;
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    location ~ /bills/parse-photo$ {
        client_max_body_size 11m;
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/accounting-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Part 3: Frontend Deployment Setup

### 3.1 Frontend Build Configuration

**vite.config.ts** (or build config)
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
```

### 3.2 Frontend Directory Structure

```bash
# On server
sudo mkdir -p /var/www/accounting-frontend
sudo chown appuser:appuser /var/www/accounting-frontend
```

### 3.3 Nginx Configuration for Frontend

```bash
sudo nano /etc/nginx/sites-available/accounting-frontend
```

**/etc/nginx/sites-available/accounting-frontend**
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    root /var/www/accounting-frontend/dist;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/json application/javascript;

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA routing - serve index.html for all routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Logging
    access_log /var/log/nginx/accounting-frontend-access.log;
    error_log /var/log/nginx/accounting-frontend-error.log;
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/accounting-frontend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Part 4: GitHub Actions CI/CD Pipeline

### 4.1 Backend GitHub Actions Workflow

Create `.github/workflows/deploy-backend.yml`:

```yaml
name: Deploy Backend

on:
  push:
    branches:
      - main
      - develop
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy'
        required: true
        default: 'production'
        type: choice
        options:
          - production
          - staging

env:
  NODE_VERSION: '20.x'

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run linter
        run: npm run lint:check
      
      - name: Run type check
        run: npm run type-check
      
      - name: Run tests
        run: npm test
      
      - name: Check migrations
        run: npm run migration:check

  build:
    name: Build
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build application
        run: npm run build
      
      - name: Create deployment package
        run: |
          mkdir -p deploy
          cp -r dist deploy/
          cp -r node_modules deploy/
          cp package.json deploy/
          cp package-lock.json deploy/
          cp ecosystem.config.js deploy/
          tar -czf backend-deploy.tar.gz deploy/
      
      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: backend-build
          path: backend-deploy.tar.gz
          retention-days: 1

  deploy:
    name: Deploy to Server
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'
    steps:
      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: backend-build
      
      - name: Deploy to server
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          source: "backend-deploy.tar.gz"
          target: "/tmp"
      
      - name: Execute deployment script
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          script: |
            cd /var/www/accounting-backend
            
            # Backup current deployment
            if [ -d "current" ]; then
              mv current "backup-$(date +%Y%m%d-%H%M%S)"
            fi
            
            # Extract new deployment
            mkdir -p current
            tar -xzf /tmp/backend-deploy.tar.gz -C current --strip-components=1
            
            # Install production dependencies only
            cd current
            npm ci --production
            
            # Run migrations
            npm run migration:up || true
            
            # Create logs directory
            mkdir -p logs
            
            # Restart application with PM2
            pm2 delete accounting-backend || true
            pm2 start ecosystem.config.js
            pm2 save
            
            # Cleanup
            rm /tmp/backend-deploy.tar.gz
            
            # Keep only last 3 backups
            cd /var/www/accounting-backend
            ls -t backup-* | tail -n +4 | xargs rm -rf || true
```

### 4.2 Frontend GitHub Actions Workflow

Create `.github/workflows/deploy-frontend.yml`:

```yaml
name: Deploy Frontend

on:
  push:
    branches:
      - main
      - develop
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy'
        required: true
        default: 'production'
        type: choice
        options:
          - production
          - staging

env:
  NODE_VERSION: '20.x'

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run linter
        run: npm run lint:check || true
      
      - name: Run type check
        run: npm run type-check || true
      
      - name: Run tests
        run: npm test || true

  build:
    name: Build
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Create production env file
        run: |
          echo "VITE_API_URL=${{ secrets.PRODUCTION_API_URL }}" > .env.production
          echo "VITE_APP_NAME=Accounting App" >> .env.production
          echo "VITE_LOG_LEVEL=error" >> .env.production
      
      - name: Build application
        run: npm run build
      
      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: frontend-build
          path: dist
          retention-days: 1

  deploy:
    name: Deploy to Server
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'
    steps:
      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: frontend-build
      
      - name: Deploy to server
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          source: "dist/*"
          target: "/tmp/frontend-deploy"
      
      - name: Execute deployment script
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          script: |
            cd /var/www/accounting-frontend
            
            # Backup current deployment
            if [ -d "current" ]; then
              mv current "backup-$(date +%Y%m%d-%H%M%S)"
            fi
            
            # Move new deployment
            mkdir -p current
            mv /tmp/frontend-deploy/* current/
            
            # Update Nginx to serve new build
            sudo systemctl reload nginx
            
            # Keep only last 3 backups
            ls -t backup-* | tail -n +4 | xargs rm -rf || true
```

### 4.3 GitHub Secrets Configuration

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add these secrets:

- `SERVER_HOST`: Your server IP or domain
- `SERVER_USER`: SSH user (e.g., `appuser`)
- `SERVER_SSH_KEY`: Private SSH key for deployment
- `SERVER_PORT`: SSH port (default: 22)
- `PRODUCTION_API_URL`: Production API URL (e.g., `https://api.yourdomain.com`)

**Generate SSH key for deployment:**
```bash
# On your local machine
ssh-keygen -t ed25519 -f ~/.ssh/deployment_key -N ""

# Copy public key to server
ssh-copy-id -i ~/.ssh/deployment_key.pub appuser@your-server-ip

# Copy private key content to GitHub secret
cat ~/.ssh/deployment_key
```

---

## Part 5: SSL Certificate Setup

### 5.1 Obtain SSL Certificates

```bash
# For backend API
sudo certbot --nginx -d api.yourdomain.com

# For frontend
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

### 5.2 Auto-renewal Setup

Certbot automatically sets up renewal, but verify:

```bash
# Test renewal
sudo certbot renew --dry-run

# Check renewal timer
sudo systemctl status certbot.timer
```

---

## Part 6: Additional Backend Requirements

### 6.1 Health Check Endpoint

**src/app.controller.ts**
```typescript
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
```

### 6.2 Logs Directory Setup

```bash
# On server
mkdir -p /var/www/accounting-backend/logs
chmod 755 /var/www/accounting-backend/logs
```

### 6.3 PM2 Startup Script

```bash
# Generate startup script
pm2 startup

# Save current PM2 processes
pm2 save
```

---

## Part 7: Release Strategies

### 7.1 Strategy Options

#### A. Manual Release (Workflow Dispatch)
- Trigger deployment manually from GitHub Actions
- Choose environment (production/staging)
- Good for controlled releases

#### B. Automatic Release on Push
- Deploy automatically when pushing to `main`
- Fastest deployment
- Requires good testing

#### C. Tag-based Release
```yaml
on:
  push:
    tags:
      - 'v*'
```

#### D. Pull Request Preview
- Deploy to staging on PR
- Deploy to production on merge

### 7.2 Recommended Strategy

**For Family Application:**
- **Develop branch** → Auto-deploy to staging
- **Main branch** → Manual approval → Deploy to production
- **Tags** → Create releases

### 7.3 Rollback Procedure

**Backend Rollback:**
```bash
# SSH to server
cd /var/www/accounting-backend
pm2 stop accounting-backend
rm -rf current
mv backup-YYYYMMDD-HHMMSS current
cd current
pm2 start ecosystem.config.js
```

**Frontend Rollback:**
```bash
cd /var/www/accounting-frontend
rm -rf current
mv backup-YYYYMMDD-HHMMSS current
sudo systemctl reload nginx
```

---

## Part 8: Monitoring and Maintenance

### 8.1 PM2 Monitoring

```bash
# View logs
pm2 logs accounting-backend

# Monitor
pm2 monit

# Status
pm2 status

# Restart
pm2 restart accounting-backend
```

### 8.2 Log Rotation

Create logrotate config:

```bash
sudo nano /etc/logrotate.d/accounting-backend
```

```
/var/www/accounting-backend/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    missingok
    create 0644 appuser appuser
}
```

### 8.3 Backup Strategy

```bash
# Database backup script
#!/bin/bash
BACKUP_DIR="/var/backups/accounting"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

pg_dump -U accounting_user accounting > $BACKUP_DIR/db_$DATE.sql
gzip $BACKUP_DIR/db_$DATE.sql

# Keep only last 7 days
find $BACKUP_DIR -name "db_*.sql.gz" -mtime +7 -delete
```

Add to crontab:
```bash
crontab -e
# Daily backup at 2 AM
0 2 * * * /path/to/backup-script.sh
```

---

## Part 9: Deployment Checklist

### Pre-Deployment
- [ ] Server prepared and configured
- [ ] Database created and configured
- [ ] SSL certificates obtained
- [ ] Nginx configured for both apps
- [ ] GitHub secrets configured
- [ ] Environment variables set
- [ ] PM2 installed and configured

### Deployment
- [ ] Backend workflow tested
- [ ] Frontend workflow tested
- [ ] Health checks working
- [ ] Logs directory created
- [ ] Backup strategy in place

### Post-Deployment
- [ ] Application accessible
- [ ] API endpoints working
- [ ] Authentication working
- [ ] Logs being written
- [ ] Monitoring set up
- [ ] Backup verified

---

## Part 10: Troubleshooting

### Common Issues

**1. Deployment fails - Permission denied**
```bash
sudo chown -R appuser:appuser /var/www/accounting-*
```

**2. PM2 not starting**
```bash
pm2 logs accounting-backend
# Check logs for errors
```

**3. Nginx 502 Bad Gateway**
- Check if backend is running: `pm2 status`
- Check backend logs: `pm2 logs`
- Verify port 3000 is accessible

**4. CORS errors**
- Verify FRONTEND_URL in backend .env
- Check Nginx CORS headers if needed

**5. Database connection errors**
- Verify database credentials
- Check PostgreSQL is running: `sudo systemctl status postgresql`
- Check firewall rules

---

## Additional Resources

- [PM2 Documentation](https://pm2.keymetrics.io/)
- [Nginx Documentation](https://nginx.org/en/docs/)
- [GitHub Actions](https://docs.github.com/en/actions)
- [Let's Encrypt](https://letsencrypt.org/)
- [Node.js Production Best Practices](https://github.com/goldbergyoni/nodebestpractices)

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-XX






