// S3 REST 客户端：daemon 内部访问 rclone serve s3（容器内 localhost，匿名模式）。
// 只实现 Davflare 需要的 S3 子集：PUT/GET/HEAD/DELETE、ListObjectsV2、Multipart。
package main

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type S3ObjectEntry struct {
	Key          string
	Size         int64
	LastModified string // ISO
	ETag         string // 带引号，如 "abc123"
}

type S3ListResult struct {
	Objects               []S3ObjectEntry
	CommonPrefixes        []string
	IsTruncated           bool
	NextContinuationToken string
}

type S3Error struct {
	Status int
	Body   string
}

func (e *S3Error) Error() string {
	body := e.Body
	if len(body) > 300 {
		body = body[:300]
	}
	return fmt.Sprintf("S3 %d: %s", e.Status, body)
}

func encodeKeyPath(key string) string {
	// 每段单独编码，保留 /；rclone serve s3 要求 canonical path 形式
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

func escapeXML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

type S3Client struct {
	base   string // http://127.0.0.1:9002
	bucket string
	hc     *http.Client
}

func NewS3Client(base, bucket string) *S3Client {
	return &S3Client{base: base, bucket: bucket, hc: &http.Client{}}
}

func (c *S3Client) url(key *string, query url.Values) string {
	var b strings.Builder
	b.WriteString(c.base)
	b.WriteByte('/')
	b.WriteString(url.PathEscape(c.bucket))
	if key != nil {
		b.WriteByte('/')
		b.WriteString(encodeKeyPath(*key))
	}
	if q := query.Encode(); q != "" {
		b.WriteByte('?')
		b.WriteString(q)
	}
	return b.String()
}

func (c *S3Client) do(method string, key *string, query url.Values, header http.Header, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(method, c.url(key, query), body)
	if err != nil {
		return nil, err
	}
	if header != nil {
		req.Header = header
	}
	return c.hc.Do(req)
}

type s3Resp struct {
	status int
	header http.Header
	text   string
}

func (c *S3Client) request(method string, key *string, query url.Values, header http.Header, body io.Reader) (*s3Resp, error) {
	resp, err := c.do(method, key, query, header, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &S3Error{Status: resp.StatusCode, Body: string(b)}
	}
	return &s3Resp{status: resp.StatusCode, header: resp.Header, text: string(b)}, nil
}

// requestStream 返回完整 Response（流式读 body 用），非 2xx 抛错；调用方负责关闭 Body。
func (c *S3Client) requestStream(method string, key *string, query url.Values, header http.Header, body io.Reader) (*http.Response, error) {
	resp, err := c.do(method, key, query, header, body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, &S3Error{Status: resp.StatusCode, Body: string(b)}
	}
	return resp, nil
}

func (c *S3Client) head(key string) (http.Header, error) {
	resp, err := c.do("HEAD", &key, nil, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &S3Error{Status: resp.StatusCode, Body: ""}
	}
	return resp.Header, nil
}

type s3ListOpts struct {
	Prefix            string
	Delimiter         string
	MaxKeys           int
	ContinuationToken string
	StartAfter        string
}

type listBucketXML struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
}

func (c *S3Client) list(opts s3ListOpts) (*S3ListResult, error) {
	query := url.Values{"list-type": {"2"}}
	if opts.Prefix != "" {
		query.Set("prefix", opts.Prefix)
	}
	if opts.Delimiter != "" {
		query.Set("delimiter", opts.Delimiter)
	}
	if opts.MaxKeys > 0 {
		query.Set("max-keys", strconv.Itoa(opts.MaxKeys))
	}
	if opts.ContinuationToken != "" {
		query.Set("continuation-token", opts.ContinuationToken)
	}
	if opts.StartAfter != "" {
		query.Set("start-after", opts.StartAfter)
	}
	resp, err := c.request("GET", nil, query, nil, nil)
	if err != nil {
		return nil, err
	}
	var root listBucketXML
	if err := xml.Unmarshal([]byte(resp.text), &root); err != nil {
		// 兜底：去掉默认 xmlns 再解析一次
		trimmed := strings.Replace(resp.text, ` xmlns="http://s3.amazonaws.com/doc/2006-03-01/"`, "", 1)
		if err2 := xml.Unmarshal([]byte(trimmed), &root); err2 != nil {
			return nil, err
		}
	}
	out := &S3ListResult{
		Objects:               make([]S3ObjectEntry, 0, len(root.Contents)),
		CommonPrefixes:        []string{},
		IsTruncated:           root.IsTruncated,
		NextContinuationToken: root.NextContinuationToken,
	}
	for _, ct := range root.Contents {
		out.Objects = append(out.Objects, S3ObjectEntry{
			Key:          ct.Key,
			Size:         ct.Size,
			LastModified: ct.LastModified,
			ETag:         ct.ETag,
		})
	}
	// CommonPrefixes 内层的 <Prefix> 才是分组；顶层 <Prefix> 是查询参数回显，忽略。
	for _, cp := range root.CommonPrefixes {
		if cp.Prefix != "" {
			out.CommonPrefixes = append(out.CommonPrefixes, cp.Prefix)
		}
	}
	return out, nil
}

func (c *S3Client) createMultipart(key string) (string, error) {
	resp, err := c.request("POST", &key, url.Values{"uploads": {""}}, nil, nil)
	if err != nil {
		return "", err
	}
	var u struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.Unmarshal([]byte(resp.text), &u); err != nil {
		return "", err
	}
	return u.UploadID, nil
}

func (c *S3Client) uploadPart(key, uploadID string, partNumber int, body io.Reader) (string, error) {
	query := url.Values{"uploadId": {uploadID}, "partNumber": {strconv.Itoa(partNumber)}}
	resp, err := c.requestStream("PUT", &key, query, nil, body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.Header.Get("Etag"), nil
}

type s3Part struct {
	PartNumber int
	ETag       string
}

func (c *S3Client) completeMultipart(key, uploadID string, parts []s3Part) error {
	var b strings.Builder
	b.WriteString("<CompleteMultipartUpload>")
	for _, p := range parts {
		b.WriteString("<Part><PartNumber>")
		b.WriteString(strconv.Itoa(p.PartNumber))
		b.WriteString("</PartNumber><ETag>")
		b.WriteString(escapeXML(p.ETag))
		b.WriteString("</ETag></Part>")
	}
	b.WriteString("</CompleteMultipartUpload>")
	header := http.Header{}
	header.Set("Content-Type", "application/xml")
	resp, err := c.request("POST", &key, url.Values{"uploadId": {uploadID}}, header, strings.NewReader(b.String()))
	if err != nil {
		return err
	}
	if strings.Contains(resp.text, "<Error>") {
		return &S3Error{Status: 400, Body: resp.text}
	}
	return nil
}

func (c *S3Client) abortMultipart(key, uploadID string) error {
	_, err := c.request("DELETE", &key, url.Values{"uploadId": {uploadID}}, nil, nil)
	return err
}
