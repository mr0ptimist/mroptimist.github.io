import os, re, glob

content_dir = os.path.join(os.path.dirname(__file__), "content", "posts")

def extract_front_matter(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.startswith("+++"):
        return {}
    end = text.find("+++", 3)
    if end == -1:
        return {}
    fm = text[3:end]
    result = {}
    for line in fm.strip().splitlines():
        line = line.strip()
        if "=" in line:
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip("'\"")
            result[key] = val
    return result

def get_existing(field):
    items = set()
    for fp in glob.glob(os.path.join(content_dir, "*.md")):
        fm = extract_front_matter(fp)
        if field in fm:
            val = fm[field]
            found = re.findall(r"[^,']+", val)
            for item in found:
                item = item.strip()
                if item:
                    items.add(item)
    return sorted(items)

def pick_or_input(field, existing):
    if existing:
        print(f"\n已有{field}:")
        for i, item in enumerate(existing, 1):
            print(f"  {i}. {item}")
        print(f"  0. 输入新的{field}")
        choice = input(f"选择编号(可多选用逗号分隔, 如 1,3): ").strip()
        result = []
        if choice:
            for c in choice.split(","):
                c = c.strip()
                if c.isdigit() and 1 <= int(c) <= len(existing):
                    result.append(existing[int(c) - 1])
                elif c == "0":
                    new = input(f"输入新{field}(逗号分隔): ").strip()
                    for n in new.split(","):
                        n = n.strip()
                        if n:
                            result.append(n)
                else:
                    result.append(c)
        if not result:
            new = input(f"输入{field}(逗号分隔): ").strip()
            for n in new.split(","):
                n = n.strip()
                if n:
                    result.append(n)
        return list(dict.fromkeys(result))
    else:
        val = input(f"输入{field}(逗号分隔): ").strip()
        return [n.strip() for n in val.split(",") if n.strip()]

def main():
    title = input("\n文章标题: ").strip()
    if not title:
        print("标题不能为空")
        return

    tags = pick_or_input("标签", get_existing("tags"))
    categories = pick_or_input("分类", get_existing("categories"))

    hidden = input("是否隐藏(y/n): ").strip().lower() == "y"

    from datetime import datetime
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")

    filename = title.replace(" ", "-")
    filepath = os.path.join(content_dir, f"{filename}.md")

    tags_str = ", ".join(f"'{t}'" for t in tags)
    cats_str = ", ".join(f"'{c}'" for c in categories)

    lines = [
        "+++",
        f"date = '{now}'",
        "draft = false",
        f"title = '{title}'",
        f"tags = [{tags_str}]",
        f"categories = [{cats_str}]",
    ]
    if hidden:
        lines.append("hidden = true")
    lines.append("+++")
    lines.append("")
    lines.append("在这里写文章内容...")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"\n已创建: {filepath}")

if __name__ == "__main__":
    main()
