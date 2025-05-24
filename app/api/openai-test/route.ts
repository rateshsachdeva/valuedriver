import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ success: false, status: res.status }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json({ success: true, models: data.data });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
