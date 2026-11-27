const f=/[",\n\r]/,E=/"/g,p=/^\s*[=+\-@|]/i;function C(t){const n=String(t??"");return p.test(n)?`'${n}`:n}function l(t){const n=C(t);return f.test(n)?`"${n.replace(E,'""')}"`:n}const b="\uFEFF",g=/\n/g;async function S(t,n,s,r=250){const c=[t.map(e=>l(e.label)).join(",")];for(let e=0;e<n.length;e++){const o=n[e];o&&(c.push(t.map(i=>l(i.value(o))).join(",")),(e+1)%r===0&&await s())}return c.join(`\r
`)}function u(t){return JSON.stringify(t,null,2)??"null"}function d(t,n){const s=" ".repeat(n);return t.replace(g,`
${s}`)}async function _(t,n,s,r,c=250){const e=Object.entries(t).map(([i,a])=>`  ${JSON.stringify(i)}: ${d(u(a),2)}`),o=[];for(let i=0;i<n.length;i++){const a=n[i];a&&(o.push(`    ${d(u(s(a)),4)}`),(i+1)%c===0&&await r())}return["{",`${e.join(`,
`)}${e.length>0?`,
`:""}  "nodes": [`,o.join(`,
`),"  ]","}"].join(`
`)}function h(t,n,s,r){const c=new Blob([r?.bom?b:"",n],{type:s}),e=URL.createObjectURL(c),o=document.createElement("a");o.href=e,o.download=t,document.body.appendChild(o),o.click(),o.remove(),URL.revokeObjectURL(e)}export{_ as a,S as b,h as d};
