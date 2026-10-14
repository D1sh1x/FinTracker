package importlab

import (
	"context"
	"time"
)

func (s *Server) Compute(ctx context.Context, data []byte, captured string) (Result, error) {
	started := time.Now()
	text, lines, err := s.OCR(ctx, data)
	if err != nil {
		return Result{}, err
	}
	rows, err := Parse(text, captured)
	if err != nil {
		return Result{}, err
	}
	applyNames(rows, lines)
	result := emptyResult()
	result.OCR = "Tesseract rus+eng"
	result.Text = text
	result.Lines = lines
	result.Rows = rows
	result.Metrics.OCRMS = time.Since(started).Milliseconds()
	if len(rows) == 0 {
		result.Warnings = append(result.Warnings, "OCR не выделил строки с суммами. Добавьте операцию вручную.")
	}
	for _, line := range lines {
		if line.Confidence < 60 {
			result.Warnings = append(result.Warnings, "В тексте есть фрагменты с низкой оценкой OCR. Сверьте суммы и знаки с изображением.")
			break
		}
	}
	metrics, warnings := s.classify(ctx, rows)
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	result.Warnings = append(result.Warnings, warnings...)
	result.Metrics.ModelMS = metrics.ModelMS
	result.Metrics.PromptTokens = metrics.PromptTokens
	result.Metrics.GeneratedTokens = metrics.GeneratedTokens
	result.Metrics.TokensPerSecond = metrics.TokensPerSecond
	result.Metrics.TotalMS = time.Since(started).Milliseconds()
	return result, nil
}
