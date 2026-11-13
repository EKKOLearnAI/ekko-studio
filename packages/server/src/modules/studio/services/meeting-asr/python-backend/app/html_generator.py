from __future__ import annotations

import json
import time
from datetime import datetime

from .models import AnalysisResult


def generate_html_report(analysis: AnalysisResult) -> str:
    relationships_json = json.dumps(analysis.relationships, ensure_ascii=False)
    people_json = json.dumps(analysis.people_mentioned, ensure_ascii=False)
    key_points_json = json.dumps(analysis.key_points, ensure_ascii=False)
    action_items_json = json.dumps(analysis.action_items, ensure_ascii=False)
    topics_json = json.dumps(analysis.topics, ensure_ascii=False)

    gen_time = datetime.fromtimestamp(analysis.timestamp).strftime("%Y-%m-%d %H:%M:%S") if analysis.timestamp else "未知"

    graph_nodes = []
    graph_links = []

    for person in analysis.people_mentioned:
        graph_nodes.append({
            "name": person,
            "symbolSize": 50,
            "category": 0,
        })

    for rel in analysis.relationships:
        source = rel.get("source", "")
        target = rel.get("target", "")
        relation = rel.get("relation", "")
        if source and target:
            graph_links.append({
                "source": source,
                "target": target,
                "value": relation,
            })

    graph_nodes_json = json.dumps(graph_nodes, ensure_ascii=False)
    graph_links_json = json.dumps(graph_links, ensure_ascii=False)

    topics_html = ""
    for topic in analysis.topics:
        topics_html += f'<span class="topic-tag">{topic}</span>\n'

    key_points_html = ""
    for i, point in enumerate(analysis.key_points, 1):
        key_points_html += f"""
        <div class="key-point-card">
            <div class="key-point-number">{i}</div>
            <div class="key-point-text">{point}</div>
        </div>"""

    action_items_html = ""
    for item in analysis.action_items:
        action_items_html += f"""
        <div class="action-item">
            <input type="checkbox" class="action-checkbox">
            <span class="action-text">{item}</span>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>会议分析报告</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }}
        .container {{
            max-width: 1400px;
            margin: 0 auto;
        }}
        .header {{
            background: rgba(255, 255, 255, 0.95);
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
        }}
        .header h1 {{
            font-size: 28px;
            color: #1a1a2e;
            margin-bottom: 10px;
        }}
        .header .meta {{
            color: #666;
            font-size: 14px;
        }}
        .summary-box {{
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            border-radius: 12px;
            padding: 20px;
            margin-top: 15px;
            font-size: 16px;
            line-height: 1.6;
            color: #333;
        }}
        .topics-container {{
            margin-top: 15px;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }}
        .topic-tag {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 14px;
        }}
        .grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }}
        .card {{
            background: rgba(255, 255, 255, 0.95);
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
        }}
        .card h2 {{
            font-size: 20px;
            color: #1a1a2e;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }}
        .card h2 .icon {{
            font-size: 24px;
        }}
        #relationship-chart {{
            width: 100%;
            height: 400px;
        }}
        .key-point-card {{
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 12px;
            background: #f8f9fa;
            border-radius: 8px;
            margin-bottom: 10px;
            transition: transform 0.2s;
        }}
        .key-point-card:hover {{
            transform: translateX(5px);
            background: #e9ecef;
        }}
        .key-point-number {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: bold;
            flex-shrink: 0;
        }}
        .key-point-text {{
            font-size: 15px;
            line-height: 1.5;
            color: #333;
        }}
        .action-item {{
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            background: #fff3cd;
            border-radius: 8px;
            margin-bottom: 10px;
            border-left: 4px solid #ffc107;
        }}
        .action-checkbox {{
            width: 20px;
            height: 20px;
            cursor: pointer;
        }}
        .action-text {{
            font-size: 15px;
            color: #333;
        }}
        .action-item:has(.action:checked) {{
            background: #d4edda;
            border-left-color: #28a745;
            text-decoration: line-through;
            opacity: 0.7;
        }}
        .footer {{
            text-align: center;
            color: rgba(255, 255, 255, 0.8);
            font-size: 14px;
            padding: 20px;
        }}
        .empty-state {{
            text-align: center;
            color: #999;
            padding: 40px;
            font-size: 15px;
        }}
        @media (max-width: 768px) {{
            .grid {{
                grid-template-columns: 1fr;
            }}
            .header h1 {{
                font-size: 22px;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 会议分析报告</h1>
            <div class="meta">生成时间：{gen_time}</div>
            <div class="summary-box">
                <strong>摘要：</strong>{analysis.summary or "暂无摘要"}
            </div>
            {f'<div class="topics-container">{topics_html}</div>' if topics_html else ''}
        </div>

        <div class="grid">
            <div class="card">
                <h2><span class="icon">👥</span> 人物关系图</h2>
                <div id="relationship-chart"></div>
            </div>

            <div class="card">
                <h2><span class="icon">📌</span> 关键要点</h2>
                {key_points_html if key_points_html else '<div class="empty-state">暂无关键要点</div>'}
            </div>

            <div class="card">
                <h2><span class="icon">✅</span> 待办事项</h2>
                {action_items_html if action_items_html else '<div class="empty-state">暂无待办事项</div>'}
            </div>

            <div class="card">
                <h2><span class="icon">🏷️</span> 会议主题</h2>
                <div class="topics-container">
                    {topics_html if topics_html else '<div class="empty-state">暂无主题分类</div>'}
                </div>
            </div>
        </div>

        <div class="footer">
            会议分析报告 · 由 AI 自动生成
        </div>
    </div>

    <script>
        (function() {{
            const chartDom = document.getElementById('relationship-chart');
            if (!chartDom) return;

            const myChart = echarts.init(chartDom);
            const nodes = {graph_nodes_json};
            const links = {graph_links_json};

            if (nodes.length === 0) {{
                chartDom.innerHTML = '<div class="empty-state">暂无人物关系数据</div>';
                return;
            }}

            const option = {{
                tooltip: {{
                    show: true,
                    formatter: function(params) {{
                        if (params.dataType === 'edge') {{
                            return params.data.value || '';
                        }}
                        return params.name;
                    }}
                }},
                series: [{{
                    type: 'graph',
                    layout: 'force',
                    animation: true,
                    label: {{
                        show: true,
                        fontSize: 14,
                        fontWeight: 'bold'
                    }},
                    force: {{
                        repulsion: 300,
                        edgeLength: [100, 200],
                        gravity: 0.1
                    }},
                    edgeLabel: {{
                        show: true,
                        fontSize: 12,
                        color: '#666',
                        formatter: function(params) {{
                            return params.data.value || '';
                        }}
                    }},
                    data: nodes.map(function(node) {{
                        return {{
                            name: node.name,
                            symbolSize: node.symbolSize || 50,
                            itemStyle: {{
                                color: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                borderColor: '#fff',
                                borderWidth: 2,
                                shadowBlur: 10,
                                shadowColor: 'rgba(0, 0, 0, 0.3)'
                            }}
                        }};
                    }}),
                    links: links.map(function(link) {{
                        return {{
                            source: link.source,
                            target: link.target,
                            value: link.value,
                            lineStyle: {{
                                color: '#667eea',
                                width: 2,
                                curveness: 0.3
                            }}
                        }};
                    }}),
                    roam: true,
                    draggable: true
                }}]
            }};

            myChart.setOption(option);
            window.addEventListener('resize', function() {{
                myChart.resize();
            }});
        }})();
    </script>
</body>
</html>"""

    return html
