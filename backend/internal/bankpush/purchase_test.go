package bankpush

import "testing"

func TestParsePurchases(t *testing.T) {
	for _, sample := range []struct{ text, amount, note string }{
		{"Покупка 43 ₽ по карте *7055 Транспорт Краснодара.\nДоступно 933,48 ₽", "4300", "Транспорт Краснодара"},
		{"Покупка 1\u00a0234,56 ₽ по карте •7055 Магнит. Доступно 90 000 ₽", "123456", "Магнит"},
		{"Покупка 0,01 ₽ по карте *7055 Неизвестный магазин", "1", "Неизвестный магазин"},
		{"Покупка 999999999,99 ₽ по карте *7055 Магазин", "99999999999", "Магазин"},
	} {
		t.Run(sample.amount, func(t *testing.T) {
			row, err := Parse(sample.text)
			if err != nil || row.Amount != sample.amount || row.Description != sample.note || row.Card != "7055" {
				t.Fatalf("Parse: %+v %v", row, err)
			}
		})
	}
}

func TestRejectAmbiguousNotification(t *testing.T) {
	for _, text := range []string{"Доступно 933,48 ₽", "Сумма 43 ₽. Карта Mir", "Код 4300", "Покупка 0 ₽ по карте *7055 Магнит", "Покупка 1000000000 ₽ по карте *7055 Магнит", "Покупка -43 ₽ по карте *7055 Магнит", "Покупка 43,001 ₽ по карте *7055 Магнит", "Покупка 43 ₽ по карте *7055 ", "Покупка 43 ₽ по карте *7055 Магнит. Доступно скрыто", "Покупка 43 ₽ по карте *7055 Магнит 99 ₽"} {
		t.Run(text, func(t *testing.T) {
			if row, err := Parse(text); err == nil {
				t.Fatalf("unexpected purchase %+v", row)
			}
		})
	}
}

func TestConservativeCategory(t *testing.T) {
	if Category("Транспорт Краснодара") != "Транспорт" || Category("Магнит 123") != "Продукты" || Category("WB") != "" || Category("Магнитные украшения") != "" {
		t.Fatal("unsafe category rule")
	}
}
