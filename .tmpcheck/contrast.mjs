const hex=h=>{h=h.replace('#','');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255)};
const lin=c=>c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);
const L=h=>{const [r,g,b]=hex(h).map(lin);return 0.2126*r+0.7152*g+0.0722*b};
const cr=(a,b)=>{const [x,y]=[L(a),L(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05)};
const pairs=[
 ['--text-3 on panel','#5f7d78','#0d211f'],
 ['--text-3 on rail','#5f7d78','#081615'],
 ['--text-3 on ink','#5f7d78','#06100f'],
 ['--text-2 on panel','#9db8b2','#0d211f'],
 ['--water on panel','#3ee0b5','#0d211f'],
 ['--water-dim on panel','#1c7f68','#0d211f'],
 ['--amber on panel','#f0a83c','#0d211f'],
 ['--alarm on panel','#ff6b5a','#0d211f'],
 ['chart line influentCod on rail','#2f6a5d','#081615'],
 ['chart axis label on rail','#5f7d78','#081615'],
 ['info text #ffb3a9 on alarm-dim','#ffb3a9','#6d2a24'],
 ['note text #f3d6a6 on panel','#f3d6a6','#0d211f'],
];
for(const [n,a,b] of pairs) console.log(n.padEnd(40), a, 'on', b, '=>', cr(a,b).toFixed(2)+':1');
