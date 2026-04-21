import sys
sys.path.insert(0, 'D:/SmartHire/backend')
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

engine = create_engine('postgresql+psycopg://postgres:postgres@localhost:5432/postgres', future=True)
Session = sessionmaker(bind=engine)
db = Session()

# Get actual columns of call_recordings
cols = db.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name='call_recordings' ORDER BY ordinal_position")).fetchall()
print('call_recordings columns:', [c[0] for c in cols])

result = db.execute(text("SELECT * FROM call_recordings WHERE session_code = 'EXAM-B9C9D33998'")).fetchall()
print('call_recordings rows:', result if result else 'NONE')

result2 = db.execute(text("SELECT session_code FROM call_analysis WHERE session_code = 'EXAM-B9C9D33998'")).fetchall()
print('call_analysis rows:', result2 if result2 else 'NONE')
db.close()
