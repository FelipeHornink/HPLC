"""HTTP-only regression tests: no PLC initialization or scans."""
import unittest,tempfile,subprocess,pathlib,http.client,json,socket,shutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
HEADER=(ROOT/'runtime/http_config.h') if (ROOT/'runtime/http_config.h').exists() else ROOT/'template/plc-project/runtime/http_config.h'
HARNESS=r'''
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <strings.h>
static const char *panel_config_path, *pid_config_path;
static int send_all(int c,const char*d,size_t n){while(n){ssize_t k=send(c,d,n,MSG_NOSIGNAL);if(k<=0)return 0;d+=k;n-=k;}return 1;}
#include "http_config.h"
int main(int argc,char**argv){panel_config_path=argv[1];pid_config_path=argv[2];int s=socket(AF_INET,SOCK_STREAM,0);sockaddr_in a={};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);if(bind(s,(sockaddr*)&a,sizeof(a)))return 1;listen(s,4);socklen_t n=sizeof(a);getsockname(s,(sockaddr*)&a,&n);printf("%u\n",ntohs(a.sin_port));fflush(stdout);while(true){int c=accept(s,0,0);std::string req;while(http_read_request(c,req)){save_config_request(c,req);req.clear();}close(c);}}
'''
class SaveConfig(unittest.TestCase):
 def test_fragmentation_validation_and_keepalive(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory); shutil.copy(HEADER,root/'http_config.h');(root/'main.cpp').write_text(HARNESS)
   subprocess.run(['g++','-std=c++17',str(root/'main.cpp'),'-o',str(root/'http-test')],check=True)
   panel=root/'panel.json';pid=root/'pid.json';panel.write_text('{"old":true}')
   process=subprocess.Popen([str(root/'http-test'),str(panel),str(pid)],stdout=subprocess.PIPE,text=True)
   try:
    port=int(process.stdout.readline());connection=http.client.HTTPConnection('127.0.0.1',port,timeout=4)
    data={'areas':{'ihm':[{'tag':'HMI_SPARE[1]','label':'Emergency \u00e7 '+('x'*80000)}]}}
    body=json.dumps(data).encode();raw=socket.create_connection(('127.0.0.1',port),timeout=4)
    header=f'POST /api/save-config?target=panel HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n'.encode()
    for chunk in [header[:20],header[20:],body[:1000],body[1000:]]:raw.sendall(chunk)
    response=http.client.HTTPResponse(raw);response.begin();self.assertEqual(response.status,200);self.assertTrue(json.loads(response.read())['ok']);raw.close();self.assertEqual(json.loads(panel.read_text()),data)
    for payload in ['{bad json','{"areas":[]}','{"areas":{"ihm":[{"tag":1}]}}']:
     connection.request('POST','/api/save-config?target=panel',payload);response=connection.getresponse();self.assertEqual(response.status,400);response.read();self.assertEqual(json.loads(panel.read_text()),data)
    connection.request('POST','/api/save-config?target=other','{}');response=connection.getresponse();self.assertEqual(response.status,400);response.read()
    connection.request('GET','/api/save-config?target=panel');response=connection.getresponse();self.assertEqual(response.status,405);response.read()
    connection.request('POST','/api/save-config?target=pid',json.dumps({'items':[]}));response=connection.getresponse();self.assertEqual(response.status,200);response.read();self.assertEqual(json.loads(pid.read_text()),{'items':[]});connection.close()
   finally:process.terminate();process.wait(timeout=3);process.stdout.close()
if __name__=='__main__':unittest.main()
