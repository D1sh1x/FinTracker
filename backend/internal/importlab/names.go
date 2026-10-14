package importlab

import (
	"context"
	"image"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type nameCandidate struct {
	text       string
	confidence float64
}

type nameReader func(context.Context, image.Image, string) (string, error)

func refineBankNames(ctx context.Context, img *image.Gray, words []word, lines []OCRLine, read nameReader) error {
	processed := 0
	for i := range lines {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := &lines[i]
		if maskedAccount.MatchString(line.Text) || !moneyWithSign.MatchString(line.Text) {
			continue
		}
		region, baseline, ok := nameRegion(words, *line, img.Bounds())
		if !ok {
			continue
		}
		if processed >= maxRows {
			break
		}
		processed++
		candidate := baseline
		crop := img.SubImage(region).(*image.Gray)
		if result, err := read(ctx, crop, "7"); err == nil {
			if refined := nameFromWords(parseWords(result)); validName(refined.text) {
				candidate = refined
			}
		}
		if candidate.confidence < 85 {
			if result, err := read(ctx, doubleGray(crop), "7"); err == nil {
				candidate = chooseName(candidate, nameFromWords(parseWords(result)))
			}
		}
		line.Name = candidate.text
		line.NameConfidence = candidate.confidence
	}
	return ctx.Err()
}

func nameRegion(words []word, line OCRLine, bounds image.Rectangle) (image.Rectangle, nameCandidate, bool) {
	var anchor *word
	for i := range words {
		item := &words[i]
		amount := moneyWithSign.FindStringIndex(item.text)
		if item.x < bounds.Dx()*7/10 || item.y < line.Box[1] || item.y+item.h > line.Box[3] || amount == nil || amount[0] != 0 {
			continue
		}
		if anchor != nil {
			return image.Rectangle{}, nameCandidate{}, false
		}
		anchor = item
	}
	if anchor == nil {
		return image.Rectangle{}, nameCandidate{}, false
	}
	names := []word{}
	region := image.Rectangle{}
	for _, item := range words {
		if item.x < bounds.Dx()*15/100 || item.x+item.w > bounds.Dx()*7/10 {
			continue
		}
		delta := item.y + item.h/2 - (anchor.y + anchor.h/2)
		if delta < -max(item.h, anchor.h)/2 || delta > max(item.h, anchor.h)/2 {
			continue
		}
		names = append(names, item)
		region = region.Union(image.Rect(item.x, item.y, item.x+item.w, item.y+item.h))
	}
	baseline := nameFromWords(names)
	if !validName(baseline.text) || region.Empty() {
		return image.Rectangle{}, nameCandidate{}, false
	}
	pad := max(6, region.Dy()/3)
	region = region.Inset(-pad).Intersect(bounds)
	if region.Empty() || region.Dx()*region.Dy() > 500000 {
		return image.Rectangle{}, nameCandidate{}, false
	}
	return region, baseline, true
}

func nameFromWords(words []word) nameCandidate {
	sort.Slice(words, func(i, j int) bool { return words[i].x < words[j].x })
	texts := []string{}
	confidence, count := 0.0, 0
	for _, item := range words {
		texts = append(texts, item.text)
		length := utf8.RuneCountInString(item.text)
		confidence += item.confidence * float64(length)
		count += length
	}
	if count == 0 {
		return nameCandidate{}
	}
	return nameCandidate{strings.Join(texts, " "), confidence / float64(count)}
}

func validName(text string) bool {
	if text == "" || utf8.RuneCountInString(text) > 500 || moneyWithSign.MatchString(text) || moneyWithCurrency.MatchString(text) {
		return false
	}
	return strings.ContainsFunc(text, unicode.IsLetter)
}

func chooseName(original, scaled nameCandidate) nameCandidate {
	if original.confidence >= 85 || !validName(scaled.text) || scaled.confidence < 70 {
		return original
	}
	cyrillic := func(text string) bool {
		return strings.ContainsFunc(text, func(r rune) bool { return unicode.In(r, unicode.Cyrillic) })
	}
	preferRussian := !cyrillic(original.text) && cyrillic(scaled.text) && scaled.confidence >= original.confidence-10
	if scaled.confidence <= original.confidence && !preferRussian {
		return original
	}
	old, improved := []rune(original.text), []rune(scaled.text)
	if len(old) == len(improved) {
		for i, r := range old {
			if r == '&' && (improved[i] == 'б' || improved[i] == 'ё') {
				improved[i] = '&'
			}
		}
	}
	scaled.text = string(improved)
	return scaled
}

func doubleGray(img *image.Gray) *image.Gray {
	result := image.NewGray(image.Rect(0, 0, img.Bounds().Dx()*2, img.Bounds().Dy()*2))
	for y := 0; y < result.Bounds().Dy(); y++ {
		for x := 0; x < result.Bounds().Dx(); x++ {
			result.SetGray(x, y, img.GrayAt(img.Bounds().Min.X+x/2, img.Bounds().Min.Y+y/2))
		}
	}
	return result
}

func applyNames(rows []Row, lines []OCRLine) {
	next := 0
	for _, line := range lines {
		if line.Text == "" || !validName(line.Name) {
			continue
		}
		for i := next; i < len(rows); i++ {
			if !strings.HasPrefix(rows[i].Source, line.Text) {
				continue
			}
			rows[i].Description = line.Name
			if line.NameConfidence < 85 {
				rows[i].Issues = append(rows[i].Issues, "Название распознано неуверенно — сверьте со скриншотом")
			}
			next = i + 1
			break
		}
	}
}
