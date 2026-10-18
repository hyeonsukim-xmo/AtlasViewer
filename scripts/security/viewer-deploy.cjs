const fs=require('node:fs'),path=require('node:path');
const P=require('../../desktop/security/license-protocol.cjs');
function generate(host,output){
  P.check(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host),'Use a DNS hostname');
  P.check(!fs.existsSync(output),'Use a new output directory');fs.mkdirSync(output,{mode:0o700});
  const write=(name,text)=>fs.writeFileSync(path.join(output,name),text,{flag:'wx',mode:0o600});
  const service=(description,command,extra='')=>`[Unit]\nDescription=${description}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nUser=exmo-results\nGroup=exmo-results\nWorkingDirectory=/opt/exmo/AtlasViewer\nExecStart=/usr/bin/node ${command}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=40\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/var/lib/exmo-results\n${extra}\n[Install]\nWantedBy=multi-user.target\n`;
  write('exmo-viewer.service',service('EXMO read-only results viewer','scripts/security/viewer-server.cjs /var/lib/exmo-results /var/lib/exmo-license /etc/exmo/results-public.json /etc/exmo/viewer.json dist-viewer 7818','EnvironmentFile=/etc/exmo/viewer.env\nSupplementaryGroups=exmo-account-read\nInaccessiblePaths=/etc/exmo/verifier-keys /var/lib/exmo-license/issuer-private.pem -/var/lib/exmo-license/model-keys').replace('After=network-online.target','After=network-online.target exmo-results.service\nRequires=exmo-results.service'));
  write('exmo-results.service',service('EXMO Desktop publication API','scripts/security/results-server.cjs serve /var/lib/exmo-results /var/lib/exmo-license /etc/exmo/results-public.json 7817','SupplementaryGroups=exmo-account-read\nInaccessiblePaths=/etc/exmo/verifier-keys /var/lib/exmo-license/issuer-private.pem -/var/lib/exmo-license/model-keys').replace('UMask=0077','UMask=0007'));
  write('exmo-verifier.service',service('EXMO private artifact verifier','scripts/security/result-verifier.cjs watch /var/lib/exmo-results /etc/exmo/verifier-keys').replace('User=exmo-results','User=exmo-verifier').replace('UMask=0077','UMask=0007').replace('After=network-online.target','After=network-online.target exmo-results.service\nRequires=exmo-results.service'));
  write('viewer.json',JSON.stringify({origin:'https://'+host,issuer:'https://identity.example.invalid',clientId:'exmo-viewer',resource:'https://account.example.invalid',jwksUrl:'https://identity.example.invalid/jwks'},null,2));
  write('viewer.env.example','EXMO_VIEWER_CLIENT_SECRET=REPLACE_WITH_IDP_CONFIDENTIAL_SECRET\n');
  write('exmo-viewer.conf',`limit_req_zone $binary_remote_addr zone=exmo_viewer:10m rate=20r/s;
server {
    listen 443 ssl;
    server_name ${host};
    ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 8k;
    # Callback query strings, cookies and bearer tokens must not enter access/error logs.
    access_log off;
    error_log /dev/null;
    location /health/ { return 404; }
    location /v1/ { return 404; }
    location / {
        limit_req zone=exmo_viewer burst=60 nodelay;
        proxy_pass http://127.0.0.1:7818;
        proxy_set_header Host ${host};
        proxy_set_header Connection "";
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering on;
        proxy_read_timeout 40s;
        proxy_send_timeout 40s;
    }
}
`);
  write('publication-location.conf',`# Include ONLY in the existing authenticated Desktop account API TLS server.
location ~ ^/v1/publications/(info|approve-origin|begin|status|part|complete|cancel|list|read|context|mesh-part|overlay-part|delete)$ {
    client_max_body_size 2m;
    access_log off;
    error_log /dev/null;
    proxy_pass http://127.0.0.1:7817;
    proxy_set_header Host 127.0.0.1:7817;
    proxy_set_header Connection close;
    proxy_request_buffering on;
    proxy_read_timeout 40s;
}
`);
  write('README.txt','Templates only. Follow docs/EXMO_SERVER_DEPLOYMENT.md before enabling services.\nPrivate verifier keys require a separate OS user. Account DB access is read-only. No static access to result storage.\n');
}
if(require.main===module){try{P.check(process.argv.length===4);generate(...process.argv.slice(2));console.log('Deployment templates created; configure and validate on the target server before enabling.');}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={generate};
