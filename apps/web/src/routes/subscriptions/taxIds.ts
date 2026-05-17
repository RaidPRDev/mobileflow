// Stripe-supported tax ID types. Values match Stripe's `tax_id.type` API enum.
// Labels mirror the human-readable format shown in Stripe's hosted billing.
export interface TaxIdType {
  value: string;
  label: string;
}

export const TAX_ID_TYPES: TaxIdType[] = [
  { value: "ae_trn", label: "AE TRN" },
  { value: "au_abn", label: "AU ABN" },
  { value: "au_arn", label: "AU ARN" },
  { value: "bg_uic", label: "BG UIC" },
  { value: "br_cnpj", label: "BR CNPJ" },
  { value: "br_cpf", label: "BR CPF" },
  { value: "ca_bn", label: "CA BN" },
  { value: "ca_gst_hst", label: "CA GST/HST" },
  { value: "ca_pst_bc", label: "CA PST-BC" },
  { value: "ca_pst_mb", label: "CA PST-MB" },
  { value: "ca_pst_sk", label: "CA PST-SK" },
  { value: "ca_qst", label: "CA QST" },
  { value: "ch_vat", label: "CH VAT" },
  { value: "cl_tin", label: "CL TIN" },
  { value: "es_cif", label: "ES CIF" },
  { value: "eu_oss_vat", label: "EU OSS VAT" },
  { value: "eu_vat", label: "EU VAT" },
  { value: "gb_vat", label: "GB VAT" },
  { value: "ge_vat", label: "GE VAT" },
  { value: "hk_br", label: "HK BR" },
  { value: "hu_tin", label: "HU TIN" },
  { value: "id_npwp", label: "ID NPWP" },
  { value: "il_vat", label: "IL VAT" },
  { value: "in_gst", label: "IN GST" },
  { value: "is_vat", label: "IS VAT" },
  { value: "jp_cn", label: "JP CN" },
  { value: "jp_rn", label: "JP RN" },
  { value: "kr_brn", label: "KR BRN" },
  { value: "li_uid", label: "LI UID" },
  { value: "mx_rfc", label: "MX RFC" },
  { value: "my_frp", label: "MY FRP" },
  { value: "my_itn", label: "MY ITN" },
  { value: "my_sst", label: "MY SST" },
  { value: "no_vat", label: "NO VAT" },
  { value: "nz_gst", label: "NZ GST" },
  { value: "ru_inn", label: "RU INN" },
  { value: "ru_kpp", label: "RU KPP" },
  { value: "sa_vat", label: "SA VAT" },
  { value: "sg_gst", label: "SG GST" },
  { value: "sg_uen", label: "SG UEN" },
  { value: "si_tin", label: "SI TIN" },
  { value: "th_vat", label: "TH VAT" },
  { value: "tw_vat", label: "TW VAT" },
  { value: "ua_vat", label: "UA VAT" },
  { value: "us_ein", label: "US EIN" },
  { value: "za_vat", label: "ZA VAT" },
];

export function taxIdLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return TAX_ID_TYPES.find((t) => t.value === value)?.label ?? value;
}
