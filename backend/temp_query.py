import sys
sys.path.insert(0, 'D:/SmartHire/backend')
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

engine = create_engine('postgresql+psycopg://postgres:postgres@localhost:5432/postgres', future=True)
Session = sessionmaker(bind=engine)
db = Session()
result = db.execute(text("SELECT session_code, transcript_text, local_path, recording_sid FROM call_recordings WHERE session_code = 'EXAM-B9C9D33998'")).fetchall()
print('call_recordings rows:', result if result else 'NONE')
result2 = db.execute(text("SELECT session_code FROM call_analysis WHERE session_code = 'EXAM-B9C9D33998'")).fetchall()
print('call_analysis rows:', result2 if result2 else 'NONE')
db.close()
