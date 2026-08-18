package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// GameModel 是模型能力接口。真实实现走 OpenAI-compatible /chat/completions,
// 测试替身返回确定性结果。开放性决策(描述/投票/复盘)交给模型,
// 规则裁决永远在 GameEngine。
type GameModel interface {
	Model() string
	IsConfigured() bool
	Describe(ctx AgentContext) (string, error)
	Vote(ctx AgentContext, allowed []*Player) (VoteResult, error)
	Review(game *GameState) (GameReview, error)
}

type VoteResult struct {
	TargetID string `json:"targetId"`
	Reason   string `json:"reason"`
}

// ModelError 映射到 HTTP 502。
type ModelError struct {
	Msg   string
	Cause error
}

func (e *ModelError) Error() string { return e.Msg }
func (e *ModelError) Unwrap() error { return e.Cause }

// ---- 真实 DeepSeek / OpenAI-compatible 客户端 ----

type DeepSeekClient struct {
	apiKey  string
	baseURL string
	model   string
	client  *http.Client
}

func NewDeepSeekClient() *DeepSeekClient {
	base := envOr("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
	base = strings.TrimRight(base, "/")
	return &DeepSeekClient{
		apiKey:  os.Getenv("DEEPSEEK_API_KEY"),
		baseURL: base,
		model:   envOr("DEEPSEEK_MODEL", "deepseek-v4-flash"),
		client:  &http.Client{},
	}
}

func (c *DeepSeekClient) Model() string      { return c.model }
func (c *DeepSeekClient) IsConfigured() bool { return len(c.apiKey) > 0 }

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (c *DeepSeekClient) Describe(actx AgentContext) (string, error) {
	sys := "你正在玩“谁是卧底”。只依据收到的私有身份、自己的词和公开信息行动。绝不说出词语本身,不虚构其他玩家信息。用自然、含蓄、像真人的中文描述,避免每轮重复角度。只输出 JSON。"
	user := map[string]any{
		"task":    "为本轮给出一句公开描述。description 需为 2–60 个字符(约 28 个汉字以内),不能包含自己的词。",
		"context": actx,
		"output":  map[string]string{"description": "string", "private_reasoning_summary": "string"},
	}
	messages := []chatMessage{{Role: "system", Content: sys}, {Role: "user", Content: mustJSON(user)}}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := c.chatJSON(messages, 0.8)
		if err != nil {
			lastErr = err
			continue
		}
		var parsed struct {
			Description string `json:"description"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			lastErr = err
			continue
		}
		desc := strings.TrimSpace(parsed.Description)
		if n := utf8.RuneCountInString(desc); n < 2 || n > 60 {
			lastErr = fmt.Errorf("描述长度不合规: %d", n)
			continue
		}
		if strings.Contains(desc, actx.Identity.Word) {
			lastErr = errors.New("描述包含秘密词")
			continue
		}
		return desc, nil
	}
	return "", &ModelError{Msg: "AI 未能生成合规描述,已自动重试;请再试一次", Cause: lastErr}
}

func (c *DeepSeekClient) Vote(actx AgentContext, allowed []*Player) (VoteResult, error) {
	allowedIDs := map[string]bool{}
	brief := make([]map[string]string, 0, len(allowed))
	for _, p := range allowed {
		allowedIDs[p.ID] = true
		brief = append(brief, map[string]string{"id": p.ID, "name": p.Name})
	}
	sys := "你正在玩“谁是卧底”。只依据自己的私有身份、词语与公开描述投票。不得读取或猜测系统未提供的隐藏字段。必须投给存活的其他玩家,并给出简短公开理由。只输出 JSON。"
	user := map[string]any{
		"task":           "选择最可疑的一名玩家。",
		"context":        actx,
		"allowedTargets": brief,
		"output":         map[string]string{"targetId": "必须来自 allowedTargets.id", "reason": "不超过 36 个汉字"},
	}
	messages := []chatMessage{{Role: "system", Content: sys}, {Role: "user", Content: mustJSON(user)}}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := c.chatJSON(messages, 0.8)
		if err != nil {
			lastErr = err
			continue
		}
		var result VoteResult
		if err := json.Unmarshal(raw, &result); err != nil {
			lastErr = err
			continue
		}
		reason := strings.TrimSpace(result.Reason)
		if n := utf8.RuneCountInString(reason); n < 2 || n > 80 {
			lastErr = fmt.Errorf("理由长度不合规: %d", n)
			continue
		}
		if !allowedIDs[result.TargetID] {
			lastErr = fmt.Errorf("无效投票目标: %s", result.TargetID)
			continue
		}
		result.Reason = reason
		return result, nil
	}
	return VoteResult{}, &ModelError{Msg: "AI 未能生成有效选票,已自动重试;请再试一次", Cause: lastErr}
}

func (c *DeepSeekClient) Review(game *GameState) (GameReview, error) {
	players := make([]map[string]any, 0, len(game.Players))
	for _, p := range game.Players {
		players = append(players, map[string]any{
			"id": p.ID, "name": p.Name, "role": p.Role, "word": p.Word, "alive": p.Alive,
		})
	}
	record := map[string]any{
		"players":      players,
		"descriptions": game.Descriptions,
		"votes":        game.Votes,
		"events":       game.Events,
		"winner":       game.Winner,
	}
	sys := "你是“谁是卧底”的专业赛后分析师。根据完整赛局生成精炼、具体、有洞察的中文复盘。只输出 JSON。"
	user := map[string]any{
		"task":   "指出关键转折、描述策略和投票逻辑。playerInsights 覆盖每名玩家。",
		"record": record,
		"output": map[string]any{
			"headline": "string", "summary": "string",
			"turningPoints": []string{"string"},
			"playerInsights": []map[string]string{{"playerId": "string", "insight": "string"}},
		},
	}
	messages := []chatMessage{{Role: "system", Content: sys}, {Role: "user", Content: mustJSON(user)}}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := c.chatJSON(messages, 0.45)
		if err != nil {
			lastErr = err
			continue
		}
		var review GameReview
		if err := json.Unmarshal(raw, &review); err != nil {
			lastErr = err
			continue
		}
		if len(review.TurningPoints) < 1 || len(review.Headline) < 2 {
			lastErr = errors.New("复盘结构不完整")
			continue
		}
		return review, nil
	}
	return GameReview{}, &ModelError{Msg: "AI 未能生成结构化复盘", Cause: lastErr}
}

func (c *DeepSeekClient) chatJSON(messages []chatMessage, temperature float64) (json.RawMessage, error) {
	if !c.IsConfigured() {
		return nil, &ModelError{Msg: "未配置 DEEPSEEK_API_KEY,请复制 .env.example 为 .env 后填写密钥"}
	}

	body := map[string]any{
		"model":           c.model,
		"messages":        messages,
		"temperature":     temperature,
		"response_format": map[string]string{"type": "json_object"},
	}
	payload := []byte(mustJSON(body))

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		raw, err := c.doRequest(ctx, payload)
		cancel()
		if err == nil {
			return raw, nil
		}
		lastErr = err
		if attempt == 0 {
			time.Sleep(600 * time.Millisecond)
		}
	}
	return nil, &ModelError{Msg: "AI 服务暂时不可用,已自动重试;请稍后再试", Cause: lastErr}
}

func (c *DeepSeekClient) doRequest(ctx context.Context, payload []byte) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := string(raw)
		if len(detail) > 240 {
			detail = detail[:240]
		}
		return nil, fmt.Errorf("DeepSeek %d: %s", resp.StatusCode, detail)
	}

	var envelope struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if len(envelope.Choices) == 0 || envelope.Choices[0].Message.Content == "" {
		return nil, errors.New("DeepSeek 返回了空内容")
	}
	return json.RawMessage(stripCodeFence(envelope.Choices[0].Message.Content)), nil
}

func stripCodeFence(content string) string {
	s := strings.TrimSpace(content)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```JSON")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
