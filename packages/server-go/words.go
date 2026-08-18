package main

var wordPairs = [][2]string{
	{"拿铁", "卡布奇诺"},
	{"月亮", "星星"},
	{"火锅", "麻辣烫"},
	{"电影", "电视剧"},
	{"橙子", "柚子"},
	{"地铁", "高铁"},
	{"猫", "狐狸"},
	{"雨伞", "雨衣"},
	{"相机", "望远镜"},
	{"钢琴", "吉他"},
	{"图书馆", "书店"},
	{"滑雪", "滑冰"},
}

func chooseWordPair(random func() float64) [2]string {
	idx := int(random() * float64(len(wordPairs)))
	if idx >= len(wordPairs) {
		idx = len(wordPairs) - 1
	}
	return wordPairs[idx]
}
