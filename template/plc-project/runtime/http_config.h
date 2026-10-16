#pragma once
#include <string>
#include <cerrno>
#include <sys/wait.h>
#include <fcntl.h>

// Consume exactly one request, including its body, so keep-alive remains aligned.
static bool http_read_request(int c, std::string &request) {
    char ch;
    while (request.size() < 32768) {
        if (recv(c, &ch, 1, 0) != 1) return false;
        request += ch;
        if (request.size() >= 4 && request.compare(request.size()-4, 4, "\r\n\r\n") == 0) break;
    }
    if (request.size() >= 32768) return false;
    size_t length = 0;
    bool seen_length = false;
    size_t line = request.find("\r\n") + 2;
    while (line < request.size()-2) {
        size_t end = request.find("\r\n", line);
        std::string header = request.substr(line, end-line);
        if (!strncasecmp(header.c_str(), "Content-Length:", 15)) {
            if (seen_length) return false;
            seen_length = true;
            char *tail = nullptr;
            const char *value = header.c_str()+15;
            while (*value == ' ') ++value;
            if (*value < '0' || *value > '9') return false;
            unsigned long parsed = strtoul(value, &tail, 10);
            while (*tail == ' ') ++tail;
            if (*tail || parsed > 2*1024*1024) return false;
            length = parsed;
        }
        if (!strncasecmp(header.c_str(), "Transfer-Encoding:", 18)) return false;
        line = end+2;
    }
    char buffer[8192];
    while (length) {
        ssize_t n = recv(c, buffer, length < sizeof(buffer) ? length : sizeof(buffer), 0);
        if (n <= 0) return false;
        request.append(buffer, (size_t)n);
        length -= (size_t)n;
    }
    return true;
}

static void config_reply(int c, int status, const char *reason, const char *body) {
    char header[512];
    int n = snprintf(header, sizeof(header), "HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n", status, reason, strlen(body));
    send_all(c, header, (size_t)n); send_all(c, body, strlen(body));
}

static void save_config_request(int c, const std::string &request) {
    if (request.compare(0, 5, "POST ")) {
        config_reply(c,405,"Method Not Allowed","{\"ok\":false,\"error\":\"Use POST to save\"}"); return;
    }
    size_t end = request.find(' ', 5);
    std::string route = request.substr(5, end-5);
    const char *target = nullptr;
    const char *kind = nullptr;
    if (route == "/api/save-config?target=panel") { target=panel_config_path; kind="panel"; }
    if (route == "/api/save-config?target=pid") { target=pid_config_path; kind="pid"; }
    if (!target) { config_reply(c,400,"Bad Request","{\"ok\":false,\"error\":\"Invalid target\"}"); return; }
    struct sockaddr_in peer; socklen_t peer_size=sizeof(peer);
    if (getpeername(c,(struct sockaddr*)&peer,&peer_size) || ntohl(peer.sin_addr.s_addr)!=INADDR_LOOPBACK) {
        config_reply(c,403,"Forbidden","{\"ok\":false,\"error\":\"Local connections only\"}"); return;
    }
    size_t body_start=request.find("\r\n\r\n")+4;
    std::string body=request.substr(body_start);
    std::string pattern=std::string(target)+".tmp.XXXXXX";
    char *temporary=strdup(pattern.c_str());
    int fd=mkstemp(temporary);
    if (fd<0) { free(temporary); config_reply(c,500,"Internal Server Error","{\"ok\":false,\"error\":\"Could not create a temporary file\"}"); return; }
    size_t written=0; bool good=true;
    while (written<body.size()) { ssize_t n=write(fd,body.data()+written,body.size()-written); if(n<=0){good=false;break;} written+=(size_t)n; }
    if (fsync(fd)) good=false;
    close(fd);
    // Python is already a runtime dependency. Parse JSON and validate the expected
    // surface before replacing the file atomically; no shell or PLC scans involved.
    const char *validator="import json,sys,os,stat\ntry:\n p,t,k=sys.argv[1:]\n with open(p,encoding='utf-8') as f: d=json.load(f)\n assert isinstance(d,dict)\n if k=='panel':\n  assert isinstance(d.get('areas'),dict)\n  assert all(isinstance(v,list) and all(isinstance(i,dict) and isinstance(i.get('tag'),str) and isinstance(i.get('label'),str) for i in v) for v in d['areas'].values())\n else:\n  assert isinstance(d.get('items'),list)\n if os.path.exists(t): os.chmod(p,stat.S_IMODE(os.stat(t).st_mode))\n os.replace(p,t)\nexcept Exception:\n sys.exit(2)\n";
    int status=0; pid_t child=-1;
    if(good) child=fork();
    if(child==0){ execlp("python3","python3","-c",validator,temporary,target,kind,(char*)nullptr); _exit(127); }
    if(child>0){ while(waitpid(child,&status,0)<0) { if(errno!=EINTR){good=false;break;} } good=good&&WIFEXITED(status)&&WEXITSTATUS(status)==0; }
    else good=false;
    unlink(temporary); free(temporary);
    if(good) config_reply(c,200,"OK","{\"ok\":true}");
    else config_reply(c,400,"Bad Request","{\"ok\":false,\"error\":\"Invalid configuration or write failure\"}");
}
