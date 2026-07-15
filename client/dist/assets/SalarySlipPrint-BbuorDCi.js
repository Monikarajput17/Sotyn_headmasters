import{f as N,e as v,r as h,j as e}from"./react-vendor-j6k_rcxr.js";import{p as _}from"./index-BLGuOniC.js";import"./net-BOeqtr82.js";import"./socket-dm1FmSOd.js";const x=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"],S=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];function p(s){return s<20?x[s]:S[Math.floor(s/10)]+(s%10?" "+x[s%10]:"")}function k(s){let n="";return s>=100&&(n+=x[Math.floor(s/100)]+" Hundred",s%=100,s&&(n+=" ")),s&&(n+=p(s)),n}function j(s){if(s=Math.round(s||0),s===0)return"Zero";if(s<0)return"Minus "+j(-s);let n="";const l=Math.floor(s/1e7);s%=1e7;const a=Math.floor(s/1e5);s%=1e5;const d=Math.floor(s/1e3);s%=1e3;const o=s;return l&&(n+=p(l)+" Crore "),a&&(n+=p(a)+" Lakh "),d&&(n+=p(d)+" Thousand "),o&&(n+=k(o)),n.trim()}function E(s){return j(s)+" Only"}const c={name:"Sotyn.Headmasters Private Limited",head:"B.K Towers, 2480/1, Gill Rd, near Grewal Hospital, Janta Nagar, Ludhiana, Punjab 141003",email:"Sales@securedengineers.com",website:"www.securedengineers.com"},$=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],t=s=>Math.round(s||0).toLocaleString("en-IN");function M(){var m;const{employee_id:s}=N(),[n]=v(),l=n.get("month")||(()=>{const i=new Date;return`${i.getFullYear()}-${String(i.getMonth()+1).padStart(2,"0")}`})(),[a,d]=h.useState(null),[o,f]=h.useState(null);if(h.useEffect(()=>{_.get(`/payroll/calculate/${s}?month=${l}`).then(i=>d(i.data)).catch(i=>{var r,g;return f(((g=(r=i.response)==null?void 0:r.data)==null?void 0:g.error)||"Failed to load")})},[s,l]),o)return e.jsx("div",{className:"p-8 text-red-600",children:o});if(!a)return e.jsx("div",{className:"p-8 text-gray-400",children:"Loading slip…"});const[u,y]=l.split("-").map(Number),b=`${$[y-1]} ${u}`,w=i=>{if(!i)return"-";const r=new Date(i);return isNaN(r)?i:`${String(r.getDate()).padStart(2,"0")}-${String(r.getMonth()+1).padStart(2,"0")}-${r.getFullYear()}`};return e.jsxs("div",{className:"bg-white min-h-screen",children:[e.jsx("style",{children:`
        @media print {
          @page { size: A4; margin: 0; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .slip-page { box-shadow: none !important; margin: 0 !important; }
        }
        @media screen {
          body { background: #f3f4f6; }
        }
        .slip-page {
          width: 210mm;
          min-height: 297mm;
          margin: 16px auto;
          background: white;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          padding: 0;
          font-family: 'Times New Roman', Times, serif;
          color: #111;
          position: relative;
        }
        .slip-header {
          display: flex;
          align-items: center;
          padding: 14px 24px 10px;
          border-bottom: 3px solid #c00;
          background: linear-gradient(to right, #fff 60%, #fef2f2);
        }
        .slip-logo {
          width: 110px;
          height: 70px;
          flex-shrink: 0;
          background: white;
          border: 2px solid #c00;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          color: #c00;
          font-size: 22px;
        }
        .slip-name {
          flex: 1;
          padding-left: 18px;
        }
        .slip-name h1 {
          font-size: 26px;
          font-weight: bold;
          color: #c00;
          letter-spacing: 1px;
          margin: 0;
        }
        .slip-name p {
          font-size: 11px;
          color: #c00;
          margin: 4px 0 0;
        }
        .slip-title {
          text-align: center;
          margin: 22px 24px 12px;
        }
        .slip-title h2 {
          font-size: 18px;
          font-weight: bold;
          margin: 0 0 6px;
        }
        .slip-title p {
          font-size: 13px;
          font-weight: 600;
          margin: 2px 0;
        }
        .slip-meta {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0 40px;
          padding: 18px 40px 8px;
          font-size: 13px;
        }
        .meta-row { display: grid; grid-template-columns: 130px 12px 1fr; padding: 4px 0; }
        .meta-row .label { font-weight: 500; }
        .meta-row .colon { font-weight: 500; }
        .earnings-table {
          margin: 18px 40px 8px;
          width: calc(100% - 80px);
          border-collapse: collapse;
          font-size: 13px;
        }
        .earnings-table th, .earnings-table td {
          border: 1px solid #999;
          padding: 6px 10px;
        }
        .earnings-table th {
          background: #f3f4f6;
          font-weight: bold;
          text-align: center;
          font-size: 14px;
        }
        .earnings-table td.amount {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .earnings-table tr.total td {
          font-weight: bold;
        }
        .in-words {
          margin: 16px 40px;
          font-size: 13px;
        }
        .footer {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          background: linear-gradient(to right, #fff 50%, #fef2f2);
          border-top: 3px solid #c00;
          padding: 12px 24px;
          text-align: right;
          font-size: 11px;
          color: #c00;
        }
        .toolbar {
          position: fixed;
          top: 12px;
          right: 12px;
          z-index: 100;
          display: flex;
          gap: 8px;
        }
        .toolbar button {
          padding: 8px 14px;
          background: #dc2626;
          color: white;
          border: none;
          border-radius: 6px;
          font-weight: bold;
          cursor: pointer;
        }
        .toolbar button.secondary {
          background: #6b7280;
        }
      `}),e.jsxs("div",{className:"toolbar no-print",children:[e.jsx("button",{onClick:()=>window.print(),children:"Print / Save PDF"}),e.jsx("button",{className:"secondary",onClick:()=>window.close(),children:"Close"})]}),e.jsxs("div",{className:"slip-page",children:[e.jsxs("div",{className:"slip-header",children:[e.jsx("div",{className:"slip-logo",children:"SE"}),e.jsxs("div",{className:"slip-name",children:[e.jsx("h1",{children:"SECURED ENGINEERS PVT. LTD."}),e.jsxs("p",{children:[e.jsx("strong",{children:"Head Office:"})," B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB)(141003)"]}),e.jsxs("p",{children:[e.jsx("strong",{children:"Corporate Office:"})," 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016"]})]})]}),e.jsxs("div",{className:"slip-title",children:[e.jsx("h2",{children:"Payslip"}),e.jsx("p",{children:c.name}),e.jsx("p",{style:{fontWeight:"normal",fontSize:12},children:c.head})]}),e.jsxs("div",{className:"slip-meta",children:[e.jsxs("div",{children:[e.jsxs("div",{className:"meta-row",children:[e.jsx("span",{className:"label",children:"Date of Joining"}),e.jsx("span",{className:"colon",children:":"}),e.jsx("span",{children:w(a.join_date)})]}),e.jsxs("div",{className:"meta-row",children:[e.jsx("span",{className:"label",children:"Pay Period"}),e.jsx("span",{className:"colon",children:":"}),e.jsx("span",{children:b})]}),e.jsxs("div",{className:"meta-row",children:[e.jsx("span",{className:"label",children:"Worked Days"}),e.jsx("span",{className:"colon",children:":"}),e.jsx("span",{children:a.paid_days})]})]}),e.jsxs("div",{children:[e.jsxs("div",{className:"meta-row",children:[e.jsx("span",{className:"label",children:"Employee Name"}),e.jsx("span",{className:"colon",children:":"}),e.jsx("span",{children:a.employee_name})]}),e.jsxs("div",{className:"meta-row",children:[e.jsx("span",{className:"label",children:"Designation"}),e.jsx("span",{className:"colon",children:":"}),e.jsx("span",{children:a.designation||"-"})]}),e.jsxs("div",{className:"meta-row",children:[e.jsx("span",{className:"label",children:"Department"}),e.jsx("span",{className:"colon",children:":"}),e.jsx("span",{children:a.department||"-"})]})]})]}),e.jsxs("table",{className:"earnings-table",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{style:{width:"32%"},children:"Earnings"}),e.jsx("th",{style:{width:"18%"},children:"Amount"}),e.jsx("th",{style:{width:"32%"},children:"Deductions"}),e.jsx("th",{style:{width:"18%"},children:"Amount"})]})}),e.jsxs("tbody",{children:[e.jsxs("tr",{children:[e.jsx("td",{children:"Basic Pay"}),e.jsx("td",{className:"amount",children:t(a.basic_pay)}),e.jsx("td",{rowSpan:4}),e.jsx("td",{rowSpan:4})]}),e.jsxs("tr",{children:[e.jsx("td",{children:"Conveyance Allowance"}),e.jsx("td",{className:"amount",children:t(a.conveyance)})]}),e.jsxs("tr",{children:[e.jsx("td",{children:"House Rent Allowance"}),e.jsx("td",{className:"amount",children:t(a.hra)})]}),e.jsxs("tr",{children:[e.jsx("td",{children:"Adhoc Allowance"}),e.jsx("td",{className:"amount",children:t(a.adhoc)})]}),e.jsxs("tr",{children:[e.jsx("td",{children:"Miscellaneous Allowance"}),e.jsx("td",{className:"amount",children:a.misc?t(a.misc):""}),e.jsx("td",{children:e.jsx("strong",{children:"Late Penalty"})}),e.jsx("td",{className:"amount",children:a.late_penalty?t(a.late_penalty):"0"})]}),(a.ot_pay>0||a.advance>0)&&e.jsxs("tr",{children:[e.jsx("td",{children:a.ot_pay>0?`Overtime Pay (${a.ot_hours}h)`:""}),e.jsx("td",{className:"amount",children:a.ot_pay>0?t(a.ot_pay):""}),e.jsx("td",{children:a.advance>0?e.jsx("strong",{children:"Advance Salary"}):""}),e.jsx("td",{className:"amount",children:a.advance>0?t(a.advance):""})]}),a.food>0&&e.jsxs("tr",{children:[e.jsx("td",{children:e.jsx("strong",{children:"Food Allowance"})}),e.jsx("td",{className:"amount",children:t(a.food)}),e.jsx("td",{}),e.jsx("td",{className:"amount"})]}),e.jsxs("tr",{className:"total",children:[e.jsx("td",{children:"Total Earnings"}),e.jsx("td",{className:"amount",children:t(a.total_earnings+(a.ot_pay||0)+(a.food||0))}),e.jsx("td",{children:e.jsx("strong",{children:"Deduction"})}),e.jsx("td",{className:"amount",children:t(a.total_deductions)})]}),e.jsxs("tr",{className:"total",children:[e.jsx("td",{colSpan:2}),e.jsx("td",{children:e.jsx("strong",{children:"Net Pay"})}),e.jsx("td",{className:"amount",children:e.jsx("strong",{children:t(a.net_pay)})})]})]})]}),e.jsxs("div",{className:"in-words",children:[e.jsx("strong",{children:"In Words"}),": ",E(a.net_pay),"."]}),e.jsxs("div",{style:{margin:"8px 40px",fontSize:11,color:"#555"},children:[e.jsx("strong",{children:"Attendance:"})," Worked ",a.paid_days," of ",a.working_days," working days",a.half_days?` • ${a.half_days} half day(s)`:"",a.absent_days?` • ${a.absent_days} absent`:"",a.late_marks?` • ${a.late_marks} late mark(s)`:"",a.late_penalty?` (penalty ₹${t(a.late_penalty)} after ${((m=a.settings)==null?void 0:m.late_grace_count)||3} free)`:"",a.paid_leaves?` • ${a.paid_leaves} paid leave(s)`:"",a.unpaid_leaves?` • ${a.unpaid_leaves} unpaid leave(s)`:"",a.sunday_worked?` • ${a.sunday_worked} Sunday(s) worked (extra +${a.sunday_worked_pay} day pay)`:""]}),e.jsxs("div",{className:"footer",children:[e.jsxs("div",{children:["Email: ",c.email]}),e.jsxs("div",{children:["Website: ",c.website]})]})]})]})}export{M as default};
