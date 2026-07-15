import{f as m,r,j as e}from"./react-vendor-j6k_rcxr.js";import{p as g}from"./index-CD-Xfw8U.js";import"./net-BOeqtr82.js";import"./socket-dm1FmSOd.js";const a={name:"SECURED ENGINEERS PVT. LTD.",head:"B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) 141003",corp:"58/A/1, First Floor, Kalu Sarai, New Delhi - 110016",email:"Sales@securedengineers.com",website:"www.securedengineers.com"};function u(){const{id:l}=m(),[d,x]=r.useState(null),[o,p]=r.useState(null);if(r.useEffect(()=>{g.get(`/procurement/indents/${l}/print`).then(t=>x(t.data)).catch(t=>{var s,c;return p(((c=(s=t.response)==null?void 0:s.data)==null?void 0:c.error)||"Failed to load")})},[l]),o)return e.jsx("div",{className:"p-8 text-red-600",children:o});if(!d)return e.jsx("div",{className:"p-8 text-gray-400",children:"Loading…"});const i=d.indent,n=d.items||[],h=t=>{if(!t)return"—";const s=new Date(t);return isNaN(s)?t:`${String(s.getDate()).padStart(2,"0")}/${String(s.getMonth()+1).padStart(2,"0")}/${s.getFullYear()}`};return e.jsxs("div",{className:"bg-white min-h-screen",children:[e.jsx("style",{children:`
        @media print {
          @page { size: A4 landscape; margin: 8mm; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .indent-page { box-shadow: none !important; margin: 0 !important; }
          tr { page-break-inside: avoid; }
        }
        @media screen { body { background: #f3f4f6; } }
        .indent-page {
          max-width: 280mm;
          margin: 16px auto;
          background: white;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          padding: 0;
          font-family: 'Times New Roman', Times, serif;
          color: #111;
        }
        .header {
          display: flex;
          align-items: center;
          padding: 14px 24px 10px;
          border-bottom: 3px solid #c00;
          background: linear-gradient(to right, #fff 60%, #fef2f2);
        }
        .logo {
          width: 80px; height: 60px; flex-shrink: 0;
          background: white; border: 2px solid #c00;
          border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          font-weight: bold; color: #c00; font-size: 20px;
        }
        .name { flex: 1; padding-left: 14px; }
        .name h1 { font-size: 22px; font-weight: bold; color: #c00; margin: 0; letter-spacing: 0.5px; }
        .name p { font-size: 10px; color: #c00; margin: 2px 0 0; }
        .title-bar {
          background: #c00; color: white;
          padding: 6px 16px; font-weight: bold; font-size: 14px;
          letter-spacing: 1px; text-align: center;
        }
        .meta {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
          padding: 10px 16px; font-size: 11px; border-bottom: 1px solid #ddd;
        }
        .meta div { background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
        .meta .label { font-size: 9px; color: #888; text-transform: uppercase; }
        .meta .val { font-weight: bold; color: #111; }
        table.items {
          width: calc(100% - 32px);
          margin: 12px 16px;
          border-collapse: collapse;
          font-size: 11px;
        }
        table.items th {
          background: #c00; color: white;
          padding: 6px 8px;
          font-size: 11px;
          text-align: left;
          border: 1px solid #a00;
        }
        table.items td {
          padding: 5px 8px;
          border: 1px solid #ddd;
          vertical-align: top;
        }
        table.items tr:nth-child(even) td { background: #fafafa; }
        .footer {
          margin: 16px;
          padding-top: 8px;
          border-top: 2px dashed #ddd;
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #666;
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
        .toolbar button.secondary { background: #6b7280; }
      `}),e.jsxs("div",{className:"toolbar no-print",children:[e.jsx("button",{onClick:()=>window.print(),children:"Print / Save PDF"}),e.jsx("button",{className:"secondary",onClick:()=>window.close(),children:"Close"})]}),e.jsxs("div",{className:"indent-page",children:[e.jsxs("div",{className:"header",children:[e.jsx("div",{className:"logo",children:"SE"}),e.jsxs("div",{className:"name",children:[e.jsx("h1",{children:a.name}),e.jsxs("p",{children:[e.jsx("strong",{children:"Head Office:"})," ",a.head]}),e.jsxs("p",{children:[e.jsx("strong",{children:"Corporate Office:"})," ",a.corp]})]})]}),e.jsx("div",{className:"title-bar",children:"INDENT — BoQ ITEMS"}),e.jsxs("div",{className:"meta",children:[e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Indent No"}),e.jsx("div",{className:"val",children:i.indent_number})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Date"}),e.jsx("div",{className:"val",children:h(i.indent_date||i.created_at)})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Site"}),e.jsx("div",{className:"val",children:i.site_name||i.client_name||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Status"}),e.jsx("div",{className:"val",children:(i.status||"").toUpperCase()})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Raised By"}),e.jsx("div",{className:"val",children:i.raised_by_name||i.created_by_name||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Location"}),e.jsx("div",{className:"val",children:i.location||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Lead No"}),e.jsx("div",{className:"val",children:i.lead_no||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Total Items"}),e.jsx("div",{className:"val",children:n.length})]})]}),e.jsxs("table",{className:"items",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{style:{width:"4%"},children:"#"}),e.jsx("th",{style:{width:"38%"},children:"BoQ Description"}),e.jsx("th",{style:{width:"22%"},children:"Sub-Item (Item Master)"}),e.jsx("th",{style:{width:"12%"},children:"Make"}),e.jsx("th",{style:{width:"8%"},className:"text-right",children:"Qty"}),e.jsx("th",{style:{width:"6%"},children:"Unit"}),e.jsx("th",{style:{width:"10%"},children:"Type"})]})}),e.jsxs("tbody",{children:[n.map((t,s)=>e.jsxs("tr",{children:[e.jsx("td",{children:s+1}),e.jsx("td",{children:t.boq_description||t.description}),e.jsxs("td",{children:[t.item_code&&e.jsxs("div",{style:{fontSize:9,color:"#888"},children:["[",t.item_code,"]"]}),e.jsx("div",{style:{fontWeight:"bold"},children:t.master_name||"—"}),(t.master_size||t.master_uom)&&e.jsxs("div",{style:{fontSize:10,color:"#666"},children:[t.master_size,t.master_uom?` / ${t.master_uom}`:""]})]}),e.jsx("td",{children:t.make||"—"}),e.jsx("td",{style:{textAlign:"right",fontWeight:"bold"},children:t.quantity}),e.jsx("td",{children:t.unit}),e.jsx("td",{children:t.item_type||"—"})]},t.id)),n.length===0&&e.jsx("tr",{children:e.jsx("td",{colSpan:"7",style:{textAlign:"center",padding:"24px",color:"#999"},children:"No items in this indent"})})]})]}),e.jsxs("div",{className:"footer",children:[e.jsxs("div",{children:["Generated from Sotyn.Headmasters · ",new Date().toLocaleString("en-IN")]}),e.jsxs("div",{children:[a.email," · ",a.website]})]})]})]})}export{u as default};
