// MJ Hielería · Emisión electrónica SUNAT (SEE-Del Contribuyente, UBL 2.1)
// Supabase Edge Function "sunat". Acciones: emitir, reenviar.
// Modo beta: usa el ambiente de pruebas de SUNAT con su usuario público MODDATOS y un certificado temporal autogenerado.
// Modo producción: necesita los secretos SUNAT_SOL_USUARIO, SUNAT_SOL_CLAVE, SUNAT_CERT_PFX_BASE64, SUNAT_CERT_CLAVE.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { SignedXml } from "npm:xml-crypto@6.0.0";
import forge from "npm:node-forge@1.3.1";
import { zipSync, unzipSync, strToU8, strFromU8 } from "npm:fflate@0.8.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const URLS: Record<string, string> = {
  beta: "https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService",
  produccion: "https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService",
};
const IGV = 0.18;

// Certificado autofirmado temporal SOLO para el ambiente beta (SUNAT beta no valida la autoridad emisora).
let betaCred: { key: string; cert: string } | null = null;
async function certificadoBeta() {
  if (betaCred) return betaCred;
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let raw = ""; pkcs8.forEach((b) => raw += String.fromCharCode(b));
  const priv = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(raw)) as any;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(priv.n, priv.e);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  const attrs = [{ name: "commonName", value: "MJ HIELERIA PRUEBAS BETA" }, { name: "countryName", value: "PE" }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(priv, forge.md.sha256.create());
  betaCred = { key: forge.pki.privateKeyToPem(priv), cert: forge.pki.certificateToPem(cert) };
  return betaCred;
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const f2 = (n: number) => r2(n).toFixed(2);
const xe = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const dec = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const limaNow = () => {
  const d = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  return { fecha: d.slice(0, 10), hora: d.slice(11, 19) };
};

// ---------- Monto en letras ----------
const U = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIUNO", "VEINTIDOS", "VEINTITRES", "VEINTICUATRO", "VEINTICINCO", "VEINTISEIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const D = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const C = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];
function cientos(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100), r = n % 100;
  let s = C[c];
  if (r) s += (s ? " " : "") + (r < 30 ? U[r] : D[Math.floor(r / 10)] + (r % 10 ? " Y " + U[r % 10] : ""));
  return s;
}
function letras(n: number): string {
  if (n === 0) return "CERO";
  const mill = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000;
  let s = "";
  if (mill) s += mill === 1 ? "UN MILLON" : cientos(mill) + " MILLONES";
  if (miles) s += (s ? " " : "") + (miles === 1 ? "MIL" : cientos(miles) + " MIL");
  if (resto) s += (s ? " " : "") + cientos(resto);
  return s.replace(/UNO MIL/g, "UN MIL").replace(/UNO MILLONES/g, "UN MILLONES");
}
const montoLetras = (t: number) => { const e = Math.floor(r2(t)), c = Math.round((r2(t) - e) * 100); return `SON ${letras(e)} CON ${String(c).padStart(2, "0")}/100 SOLES`; };

// ---------- XML UBL 2.1 ----------
type Linea = { codigo: string; desc: string; cant: number; precio: number };
function construirXML(o: {
  tipo: "01" | "03"; serie: string; correlativo: number; fecha: string; hora: string;
  emisor: { ruc: string; razon: string; comercial: string; ubigeo: string; dep: string; prov: string; dist: string; direccion: string };
  cliente: { tipoDoc: string; numDoc: string; nombre: string; direccion?: string };
  lineas: Linea[];
}) {
  const id = `${o.serie}-${o.correlativo}`;
  let gravada = 0, igv = 0;
  const lineasXml = o.lineas.map((l, i) => {
    const base = r2(l.cant * l.precio), imp = r2(base * IGV), pu = r2(l.precio * (1 + IGV));
    gravada = r2(gravada + base); igv = r2(igv + imp);
    return `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="NIU">${l.cant}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="PEN">${f2(base)}</cbc:LineExtensionAmount><cac:PricingReference><cac:AlternativeConditionPrice><cbc:PriceAmount currencyID="PEN">${f2(pu)}</cbc:PriceAmount><cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference><cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${f2(imp)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">${f2(base)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">${f2(imp)}</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>18</cbc:Percent><cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode><cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:Item><cbc:Description>${xe(l.desc)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${xe(l.codigo)}</cbc:ID></cac:SellersItemIdentification></cac:Item><cac:Price><cbc:PriceAmount currencyID="PEN">${f2(l.precio)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  }).join("");
  const total = r2(gravada + igv);
  const e = o.emisor, c = o.cliente;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${id}</cbc:ID><cbc:IssueDate>${o.fecha}</cbc:IssueDate><cbc:IssueTime>${o.hora}</cbc:IssueTime><cbc:InvoiceTypeCode listID="0101">${o.tipo}</cbc:InvoiceTypeCode><cbc:Note languageLocaleID="1000">${xe(montoLetras(total))}</cbc:Note><cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode><cac:Signature><cbc:ID>${e.ruc}</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${e.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${xe(e.razon)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignatureSP</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${e.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${xe(e.comercial || e.razon)}</cbc:Name></cac:PartyName><cac:PartyLegalEntity><cbc:RegistrationName>${xe(e.razon)}</cbc:RegistrationName><cac:RegistrationAddress><cbc:ID>${xe(e.ubigeo)}</cbc:ID><cbc:AddressTypeCode>0000</cbc:AddressTypeCode><cbc:CityName>${xe(e.prov)}</cbc:CityName><cbc:CountrySubentity>${xe(e.dep)}</cbc:CountrySubentity><cbc:District>${xe(e.dist)}</cbc:District><cac:AddressLine><cbc:Line>${xe(e.direccion || "-")}</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${c.tipoDoc}">${xe(c.numDoc)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${xe(c.nombre)}</cbc:RegistrationName>${c.direccion ? `<cac:RegistrationAddress><cac:AddressLine><cbc:Line>${xe(c.direccion)}</cbc:Line></cac:AddressLine></cac:RegistrationAddress>` : ""}</cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>${o.tipo === "01" ? `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>` : ""}<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${f2(igv)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">${f2(gravada)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">${f2(igv)}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="PEN">${f2(gravada)}</cbc:LineExtensionAmount><cbc:TaxInclusiveAmount currencyID="PEN">${f2(total)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="PEN">${f2(total)}</cbc:PayableAmount></cac:LegalMonetaryTotal>${lineasXml}</Invoice>`;
  return { xml, gravada, igv, total };
}

// ---------- Certificado y firma ----------
async function credenciales(modo: string, ruc: string) {
  if (modo !== "produccion") { const b = await certificadoBeta(); return { user: `${ruc}MODDATOS`, pass: "moddatos", key: b.key, cert: b.cert }; }
  const user = Deno.env.get("SUNAT_SOL_USUARIO"), pass = Deno.env.get("SUNAT_SOL_CLAVE");
  const pfx = Deno.env.get("SUNAT_CERT_PFX_BASE64"), pfxPass = Deno.env.get("SUNAT_CERT_CLAVE") ?? "";
  if (!user || !pass || !pfx) throw new Error("Faltan los secretos de producción (SUNAT_SOL_USUARIO, SUNAT_SOL_CLAVE, SUNAT_CERT_PFX_BASE64, SUNAT_CERT_CLAVE).");
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfx.replace(/\s/g, ""))), pfxPass);
  const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0]
    ?? (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])[0];
  const certBag = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])[0];
  if (!keyBag?.key || !certBag?.cert) throw new Error("No se pudo leer el certificado .pfx (revisa la clave del certificado).");
  const usuario = user.startsWith(ruc) ? user : `${ruc}${user}`;
  return { user: usuario, pass, key: forge.pki.privateKeyToPem(keyBag.key), cert: forge.pki.certificateToPem(certBag.cert) };
}
function firmar(xml: string, key: string, cert: string) {
  const sig = new SignedXml({
    privateKey: key,
    publicCert: cert,
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  });
  sig.addReference({
    xpath: "/*",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    isEmptyUri: true,
  });
  sig.computeSignature(xml, {
    prefix: "ds",
    attrs: { Id: "SignatureSP" },
    location: { reference: "//*[local-name(.)='ExtensionContent']", action: "append" },
  });
  const firmado = sig.getSignedXml();
  const hash = (firmado.match(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/) ?? [])[1] ?? "";
  return { firmado, hash };
}

// ---------- Envío a SUNAT ----------
async function enviar(modo: string, cred: { user: string; pass: string }, nombre: string, xml: string) {
  const zip = zipSync({ [`${nombre}.xml`]: strToU8(xml) });
  const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${xe(cred.user)}</wsse:Username><wsse:Password>${xe(cred.pass)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body><ser:sendBill><fileName>${nombre}.zip</fileName><contentFile>${b64(zip)}</contentFile></ser:sendBill></soapenv:Body></soapenv:Envelope>`;
  let res: Response;
  try {
    res = await fetch(URLS[modo] ?? URLS.beta, { method: "POST", headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: "urn:sendBill" }, body: soap });
  } catch (e) {
    return { estado: "ERROR", codigo: "RED", mensaje: "No se pudo conectar con SUNAT: " + (e as Error).message, cdr: null };
  }
  const txt = await res.text();
  const app = txt.match(/<applicationResponse>([^<]+)<\/applicationResponse>/);
  if (app) {
    const files = unzipSync(unb64(app[1]));
    const cdrName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".xml"));
    const cdrXml = cdrName ? strFromU8(files[cdrName]) : "";
    const codigo = (cdrXml.match(/<cbc:ResponseCode[^>]*>([^<]+)</) ?? [])[1] ?? "";
    const desc = (cdrXml.match(/<cbc:Description>([^<]*)</) ?? [])[1] ?? "";
    const notas = [...cdrXml.matchAll(/<cbc:Note>([^<]*)</g)].map((m) => m[1]);
    const n = Number(codigo);
    const estado = n === 0 ? (notas.length ? "OBSERVADO" : "ACEPTADO") : n >= 4000 ? "OBSERVADO" : "RECHAZADO";
    return { estado, codigo, mensaje: dec([desc, ...notas].filter(Boolean).join(" | ")), cdr: app[1] };
  }
  const fcode = (txt.match(/<faultcode>([^<]*)<\/faultcode>/) ?? [])[1] ?? String(res.status);
  const fstr = (txt.match(/<faultstring>([^<]*)<\/faultstring>/) ?? [])[1] ?? txt.slice(0, 300);
  const num = Number((fcode.match(/(\d{3,4})/) ?? [])[1] ?? 0);
  return { estado: num >= 2000 && num < 4000 ? "RECHAZADO" : "ERROR", codigo: String(num || fcode), mensaje: dec(fstr), cdr: null };
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: esAdmin } = await sb.rpc("hielo_es_admin");
    if (!esAdmin) return json({ error: "No autorizado." }, 401);
    const body = await req.json();

    const { data: emp, error: eErr } = await sb.from("hielo_empresa").select("*").eq("id", 1).single();
    if (eErr) throw eErr;
    const modo = emp.sunat_modo === "produccion" ? "produccion" : "beta";
    const ruc = String(emp.ruc || "").trim() || (modo === "beta" ? "20000000001" : "");
    if (!/^\d{11}$/.test(ruc)) return json({ error: "Configura el RUC de la empresa (11 dígitos) en Configuración." }, 400);
    const emisor = {
      ruc, razon: emp.razon_social || emp.nombre, comercial: emp.nombre_comercial || emp.nombre,
      ubigeo: emp.ubigeo || "150101", dep: emp.departamento || "LIMA", prov: emp.provincia || "LIMA",
      dist: emp.distrito_fiscal || "LIMA", direccion: emp.direccion || "-",
    };

    // Verificar credenciales de producción SIN emitir: lee el certificado y consulta a SUNAT un comprobante inexistente.
    if (body.accion === "verificar") {
      const out: Record<string, unknown> = {
        secretos: Object.fromEntries(["SUNAT_SOL_USUARIO", "SUNAT_SOL_CLAVE", "SUNAT_CERT_PFX_BASE64", "SUNAT_CERT_CLAVE"].map((k) => [k, !!Deno.env.get(k)])),
      };
      try {
        const cred = await credenciales("produccion", ruc);
        const cert = forge.pki.certificateFromPem(cred.cert);
        out.certificado = { ok: true, titular: cert.subject.attributes.map((a: any) => a.value).join(" | "), vence: cert.validity.notAfter.toISOString().slice(0, 10) };
        const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${xe(cred.user)}</wsse:Username><wsse:Password>${xe(cred.pass)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body><ser:getStatusCdr><rucComprobante>${ruc}</rucComprobante><tipoComprobante>03</tipoComprobante><serieComprobante>B999</serieComprobante><numeroComprobante>99999999</numeroComprobante></ser:getStatusCdr></soapenv:Body></soapenv:Envelope>`;
        const res = await fetch("https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService", { method: "POST", headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: "urn:getStatusCdr" }, body: soap });
        const txt = await res.text();
        const code = (txt.match(/<statusCode>([^<]*)</) ?? txt.match(/<faultcode>([^<]*)</) ?? [])[1] ?? String(res.status);
        const msg = dec((txt.match(/<statusMessage>([^<]*)</) ?? txt.match(/<faultstring>([^<]*)</) ?? [])[1] ?? txt.slice(0, 200));
        const authFail = /0102|0103|0104|0109|0111|usuario|clave|autoriz/i.test(code + " " + msg) && !/no existe/i.test(msg);
        out.sol = { ok: !authFail, codigo: code, mensaje: msg };
      } catch (e) {
        out.error = (e as Error).message;
      }
      return json(out);
    }

    let comp: Record<string, any>;
    let venta: Record<string, any>;
    if (body.accion === "reenviar") {
      const { data, error } = await sb.from("hielo_comprobantes").select("*").eq("id", body.comprobante_id).single();
      if (error) throw error;
      if (["ACEPTADO", "OBSERVADO"].includes(data.estado)) return json({ error: "Este comprobante ya fue aceptado por SUNAT." }, 400);
      comp = data;
      const v = await sb.from("hielo_ventas").select("*").eq("id", comp.venta_id).single();
      if (v.error) throw v.error;
      venta = v.data;
    } else {
      const tipo = body.tipo === "01" ? "01" : "03";
      const v = await sb.from("hielo_ventas").select("*").eq("id", body.venta_id).single();
      if (v.error) throw v.error;
      venta = v.data;
      const prev = await sb.from("hielo_comprobantes").select("id,serie,correlativo,estado").eq("venta_id", venta.id).eq("modo", modo).in("estado", ["ACEPTADO", "OBSERVADO", "PENDIENTE"]);
      if (prev.data?.length) return json({ error: `Esta venta ya tiene el comprobante ${prev.data[0].serie}-${prev.data[0].correlativo}.` }, 400);
      if (!venta.con_igv) return json({ error: "La venta está marcada sin IGV." }, 400);
      const cli = body.cliente ?? {};
      let tipoDoc = "0", numDoc = "-", nombre = String(cli.nombre || "CLIENTES VARIOS").trim().toUpperCase();
      const doc = String(cli.num_doc || "").trim();
      if (tipo === "01") {
        if (!/^\d{11}$/.test(doc)) return json({ error: "Para factura se necesita el RUC del cliente (11 dígitos)." }, 400);
        if (!cli.nombre) return json({ error: "Para factura se necesita la razón social del cliente." }, 400);
        tipoDoc = "6"; numDoc = doc;
      } else if (doc) {
        if (cli.tipo_doc === "RUC" && /^\d{11}$/.test(doc)) tipoDoc = "6";
        else if (cli.tipo_doc === "CE") tipoDoc = "4";
        else if (/^\d{8}$/.test(doc)) tipoDoc = "1";
        else return json({ error: "El DNI debe tener 8 dígitos." }, 400);
        numDoc = doc;
      } else if (Number(venta.total) > 700) {
        return json({ error: "Boletas mayores a S/ 700 necesitan el DNI del cliente." }, 400);
      }
      const serie = tipo === "01" ? (emp.serie_factura || "F001") : (emp.serie_boleta || "B001");
      const { data: corr, error: cErr } = await sb.rpc("hielo_siguiente_correlativo", { p_modo: modo, p_serie: serie, p_tipo: tipo });
      if (cErr) throw cErr;
      const ins = await sb.from("hielo_comprobantes").insert({
        venta_id: venta.id, modo, tipo, serie, correlativo: corr, fecha_emision: limaNow().fecha,
        cliente_tipo_doc: tipoDoc, cliente_num_doc: numDoc, cliente_nombre: nombre, cliente_direccion: cli.direccion || null,
      }).select().single();
      if (ins.error) throw ins.error;
      comp = ins.data;
    }

    const lineas: Linea[] = [];
    if (venta.cant_15 > 0) lineas.push({ codigo: "H15", desc: "BOLSA DE HIELO 1.5 KG", cant: venta.cant_15, precio: Number(venta.precio_15) });
    if (venta.cant_3 > 0) lineas.push({ codigo: "H30", desc: "BOLSA DE HIELO 3 KG", cant: venta.cant_3, precio: Number(venta.precio_3) });
    const { hora } = limaNow();
    const doc = construirXML({
      tipo: comp.tipo, serie: comp.serie, correlativo: comp.correlativo, fecha: comp.fecha_emision, hora, emisor,
      cliente: { tipoDoc: comp.cliente_tipo_doc, numDoc: comp.cliente_num_doc, nombre: comp.cliente_nombre, direccion: comp.cliente_direccion },
      lineas,
    });
    const cred = await credenciales(comp.modo, ruc);
    const { firmado, hash } = firmar(doc.xml, cred.key, cred.cert);
    const nombreArchivo = `${ruc}-${comp.tipo}-${comp.serie}-${comp.correlativo}`;
    const r = await enviar(comp.modo, cred, nombreArchivo, firmado);
    const upd = await sb.from("hielo_comprobantes").update({
      gravada: doc.gravada, igv: doc.igv, total: doc.total, hash, xml: firmado,
      estado: r.estado, sunat_codigo: r.codigo, sunat_mensaje: r.mensaje, cdr: r.cdr,
    }).eq("id", comp.id).select("id,tipo,serie,correlativo,estado,sunat_codigo,sunat_mensaje,total,hash,modo").single();
    if (upd.error) throw upd.error;
    return json({ ok: ["ACEPTADO", "OBSERVADO"].includes(r.estado), comprobante: upd.data });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});
