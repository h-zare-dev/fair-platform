export const shadowReasons: Record<string, string> = {
  MISSING_DURATION: 'مدت پکیج قابل اثبات نیست',
  PRICING_MISSING: 'پکیج یا قیمت متناظر تعریف نشده',
  UNEXPECTED_UNLIMITED: 'حجم نامحدود نیازمند بررسی است',
  AMBIGUOUS_CORRELATION: 'ارتباط رویدادها نامشخص است',
  AMBIGUOUS_CORRECTION: 'حذف یا ایجاد مجدد در همان روز',
  PRICING_CONFIG_CONFLICT: 'تداخل یا خطای تنظیمات پکیج',
  LATE_EVENT_AFTER_CLOSE: 'رویداد پس از بستن روز دریافت شده',
};
