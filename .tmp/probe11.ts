import { assertSafeBaseUrl } from '../src/ai/providers';
for(const u of ['http://[febf::1]/','http://[fd00:ec2::254]/','http://[::ffff:169.254.169.254]/','http://foo.169.254.169.254.nip.io/','http://169.254.169.254.sslip.io/','http://metadata.google.internal./','http://100.100.100.200./']){
  try{console.log('ACCEPT',u,'=>',assertSafeBaseUrl(u).href);}catch(e:any){console.log('block',u,e.message);}
}
