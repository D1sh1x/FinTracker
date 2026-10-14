package importlab

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

type OCRFunc func(context.Context, []byte) (string, []OCRLine, error)

type word struct {
	text       string
	x, y, w, h int
	confidence float64
}

func Tesseract(ctx context.Context, data []byte) (string, []OCRLine, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") {
		return "", nil, fmt.Errorf("Загрузите PNG или JPEG")
	}
	if config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 20000000 {
		return "", nil, fmt.Errorf("Изображение должно содержать не более 20 млн пикселей")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", nil, fmt.Errorf("Не удалось прочитать изображение")
	}
	bounds := img.Bounds()
	var sum uint64
	for y := bounds.Min.Y; y < bounds.Max.Y; y += 8 {
		for x := bounds.Min.X; x < bounds.Max.X; x += 8 {
			v := color.GrayModel.Convert(img.At(x, y)).(color.Gray)
			sum += uint64(v.Y)
		}
	}
	samples := uint64((config.Width+7)/8) * uint64((config.Height+7)/8)
	gray := image.NewGray(image.Rect(0, 0, config.Width, config.Height))
	invert := sum/samples < 110
	for y := 0; y < config.Height; y++ {
		if y%64 == 0 {
			if err := ctx.Err(); err != nil {
				return "", nil, err
			}
		}
		for x := 0; x < config.Width; x++ {
			v := color.GrayModel.Convert(img.At(x+bounds.Min.X, y+bounds.Min.Y)).(color.Gray)
			if invert {
				v.Y = 255 - v.Y
			}
			gray.SetGray(x, y, v)
		}
	}
	tsv, err := recognize(ctx, gray, "11")
	if err != nil {
		return "", nil, err
	}
	lines := parseTSV(tsv)
	texts := make([]string, len(lines))
	for i, line := range lines {
		texts[i] = line.Text
	}
	text := strings.Join(texts, "\n")
	if isBankHistory(text) {
		if err := refineBankNames(ctx, gray, parseWords(tsv), lines, recognize); err != nil {
			return "", nil, err
		}
	}
	return text, lines, nil
}

func recognize(ctx context.Context, img image.Image, psm string) (string, error) {
	var input bytes.Buffer
	if err := png.Encode(&input, img); err != nil {
		return "", err
	}
	command := exec.CommandContext(ctx, "tesseract", "stdin", "stdout", "-l", "rus+eng", "--psm", psm, "tsv")
	command.Stdin = &input
	var output bytes.Buffer
	command.Stdout = &output
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("OCR не завершился. Проверьте загрузку Tesseract и повторите")
	}
	return output.String(), nil
}

func parseWords(tsv string) []word {
	words := []word{}
	for _, line := range strings.Split(tsv, "\n") {
		parts := strings.SplitN(line, "\t", 12)
		if len(parts) != 12 || parts[0] != "5" || strings.TrimSpace(parts[11]) == "" {
			continue
		}
		item := word{text: strings.TrimSpace(parts[11])}
		values := []*int{&item.x, &item.y, &item.w, &item.h}
		valid := true
		for i, value := range values {
			n, err := strconv.Atoi(parts[i+6])
			if err != nil || n < 0 {
				valid = false
				break
			}
			*value = n
		}
		var err error
		item.confidence, err = strconv.ParseFloat(parts[10], 64)
		if valid && err == nil && item.confidence >= 0 {
			words = append(words, item)
		}
	}
	return words
}

func parseTSV(tsv string) []OCRLine {
	words := parseWords(tsv)
	sort.Slice(words, func(i, j int) bool { return words[i].y+words[i].h/2 < words[j].y+words[j].h/2 })
	groups := [][]word{}
	for _, item := range words {
		if len(groups) > 0 {
			first := groups[len(groups)-1][0]
			delta := (item.y + item.h/2) - (first.y + first.h/2)
			if delta <= max(5, max(item.h, first.h)/2) {
				groups[len(groups)-1] = append(groups[len(groups)-1], item)
				continue
			}
		}
		groups = append(groups, []word{item})
	}
	result := []OCRLine{}
	for _, group := range groups {
		sort.Slice(group, func(i, j int) bool { return group[i].x < group[j].x })
		line := OCRLine{Confidence: 100, Box: [4]int{group[0].x, group[0].y, group[0].x + group[0].w, group[0].y + group[0].h}}
		texts := []string{}
		for _, item := range group {
			texts = append(texts, item.text)
			line.Confidence = min(line.Confidence, item.confidence)
			line.Box[0] = min(line.Box[0], item.x)
			line.Box[1] = min(line.Box[1], item.y)
			line.Box[2] = max(line.Box[2], item.x+item.w)
			line.Box[3] = max(line.Box[3], item.y+item.h)
		}
		line.Text = strings.Join(texts, " ")
		result = append(result, line)
	}
	return result
}
