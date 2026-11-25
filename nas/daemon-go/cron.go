// 轻量 5 字段 cron 解析：分 时 日 月 周，支持 * , - / ；零第三方依赖。
// 日/周同时受限时按 vixie-cron 语义取 OR。
package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type cronSpec struct {
	min, hour, dom, mon, dow map[int]bool
	domStar, dowStar         bool
}

var cronFieldRanges = []struct{ lo, hi int }{
	{0, 59}, // minute
	{0, 23}, // hour
	{1, 31}, // day of month
	{1, 12}, // month
	{0, 7},  // day of week（0 和 7 都是周日）
}

func parseCron(spec string) (*cronSpec, error) {
	// Quartz 风格的 "?"（日/周无指定值）归一化为 crontab 的 "*"
	spec = strings.ReplaceAll(spec, "?", "*")
	fields := strings.Fields(spec)
	if len(fields) != 5 {
		return nil, fmt.Errorf("cron 需要 5 个字段（分 时 日 月 周），得到 %d 个", len(fields))
	}
	c := &cronSpec{
		min: map[int]bool{}, hour: map[int]bool{}, dom: map[int]bool{}, mon: map[int]bool{}, dow: map[int]bool{},
	}
	for i, f := range fields {
		set, star, err := parseCronField(f, cronFieldRanges[i].lo, cronFieldRanges[i].hi)
		if err != nil {
			return nil, fmt.Errorf("第 %d 个字段 %q 无效: %w", i+1, f, err)
		}
		switch i {
		case 0:
			c.min = set
		case 1:
			c.hour = set
		case 2:
			c.dom, c.domStar = set, star
		case 3:
			c.mon = set
		case 4:
			c.dow, c.dowStar = set, star
		}
	}
	return c, nil
}

func parseCronField(f string, lo, hi int) (map[int]bool, bool, error) {
	set := map[int]bool{}
	star := f == "*"
	for _, part := range strings.Split(f, ",") {
		step := 1
		rng := part
		if idx := strings.Index(part, "/"); idx >= 0 {
			s, err := strconv.Atoi(part[idx+1:])
			if err != nil || s <= 0 {
				return nil, false, fmt.Errorf("步长 %q 无效", part[idx+1:])
			}
			step = s
			rng = part[:idx]
		}
		var a, b int
		switch {
		case rng == "*":
			a, b = lo, hi
		case strings.Contains(rng, "-"):
			ab := strings.SplitN(rng, "-", 2)
			var err error
			if a, err = strconv.Atoi(ab[0]); err != nil {
				return nil, false, err
			}
			if b, err = strconv.Atoi(ab[1]); err != nil {
				return nil, false, err
			}
		default:
			var err error
			if a, err = strconv.Atoi(rng); err != nil {
				return nil, false, err
			}
			b = a
		}
		if a < lo || b > hi || a > b {
			return nil, false, fmt.Errorf("范围 %d-%d 超出 %d-%d", a, b, lo, hi)
		}
		for v := a; v <= b; v += step {
			if v == 7 && hi == 7 { // 周日：7 归一为 0
				set[0] = true
			} else {
				set[v] = true
			}
		}
	}
	return set, star, nil
}

func (c *cronSpec) match(t time.Time) bool {
	if !c.min[t.Minute()] || !c.hour[t.Hour()] || !c.mon[int(t.Month())] {
		return false
	}
	domOK := c.dom[t.Day()]
	dowOK := c.dow[int(t.Weekday())]
	if c.domStar && c.dowStar {
		return true
	}
	if c.domStar {
		return dowOK
	}
	if c.dowStar {
		return domOK
	}
	return domOK || dowOK
}

// nextAfter 返回 t 之后下一个匹配时刻（最多扫一年）；无匹配返回零值。
func (c *cronSpec) nextAfter(t time.Time) time.Time {
	tt := t.Truncate(time.Minute).Add(time.Minute)
	limit := t.AddDate(1, 0, 0)
	for tt.Before(limit) {
		if c.match(tt) {
			return tt
		}
		tt = tt.Add(time.Minute)
	}
	return time.Time{}
}
